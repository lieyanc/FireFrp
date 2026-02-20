// Package tunnel manages embedded frp client (frpc) connections.
// It builds frp client configurations and starts TCP tunnel services
// using the frp client library (v0.67.0).
package tunnel

import (
	"bytes"
	"context"
	"fmt"
	"strings"

	"github.com/fatedier/frp/client"
	v1 "github.com/fatedier/frp/pkg/config/v1"
	frplog "github.com/fatedier/frp/pkg/util/log"
	goliblog "github.com/fatedier/golib/log"
	"github.com/samber/lo"
)

// Status represents the current state of the tunnel connection.
type Status int

const (
	StatusConnecting    Status = iota // Attempting to connect to frps
	StatusConnected                   // Successfully connected and tunnel is active
	StatusReconnecting                // Connection lost, attempting to reconnect
	StatusRejected                    // Server rejected the connection (e.g. invalid key)
	StatusError                       // An error occurred
	StatusClosed                      // Tunnel has been closed
)

// String returns a human-readable description of the status.
func (s Status) String() string {
	switch s {
	case StatusConnecting:
		return "connecting"
	case StatusConnected:
		return "connected"
	case StatusReconnecting:
		return "reconnecting"
	case StatusRejected:
		return "rejected"
	case StatusError:
		return "error"
	case StatusClosed:
		return "closed"
	default:
		return "unknown"
	}
}

// StatusUpdate carries a status change notification for the tunnel.
type StatusUpdate struct {
	Status  Status
	Message string
	Error   error
}

// LogEntry represents a parsed frpc log line.
type LogEntry struct {
	Time    string // HH:MM:SS
	Level   string // I, W, E, D, T
	Message string // Log message text (source file reference stripped)
}

// logWriter implements io.Writer to capture frpc log output.
// It buffers incoming bytes, splits on newlines, parses each line,
// and sends LogEntry values to a channel.
type logWriter struct {
	ch  chan<- LogEntry
	buf bytes.Buffer
}

func (w *logWriter) Write(p []byte) (n int, err error) {
	n = len(p)
	w.buf.Write(p)
	for {
		line, err := w.buf.ReadString('\n')
		if err != nil {
			// Incomplete line — put it back for next Write call.
			w.buf.WriteString(line)
			break
		}
		line = strings.TrimRight(line, "\r\n")
		if entry, ok := parseLogLine(line); ok {
			select {
			case w.ch <- entry:
			default:
			}
		}
	}
	return n, nil
}

// parseLogLine parses a frpc log line of the form:
//
//	"YYYY-MM-DD HH:MM:SS.mmm [L] [source/file.go:line] message"
//
// It extracts the time (HH:MM:SS), level letter, and message (with
// the date, milliseconds, and source reference stripped).
func parseLogLine(line string) (LogEntry, bool) {
	// Minimal length: "YYYY-MM-DD HH:MM:SS.mmm [X] msg" = 32 chars
	if len(line) < 32 {
		return LogEntry{}, false
	}

	// Extract time portion (characters 11..18 = "HH:MM:SS").
	timePart := line[11:19]

	// Find the level in square brackets after the timestamp.
	// Expected format: "... [L] ..."
	rest := line[24:] // skip "YYYY-MM-DD HH:MM:SS.mmm "
	if len(rest) < 3 || rest[0] != '[' || rest[2] != ']' {
		return LogEntry{}, false
	}
	level := string(rest[1])

	// Skip past "[L] "
	msg := rest[4:]

	// Strip the optional "[source/file.go:line] " prefix from the message.
	if len(msg) > 0 && msg[0] == '[' {
		if idx := strings.Index(msg, "] "); idx != -1 {
			msg = msg[idx+2:]
		}
	}

	return LogEntry{
		Time:    timePart,
		Level:   level,
		Message: msg,
	}, true
}

// TunnelConfig holds all parameters required to establish a TCP tunnel via frp.
type TunnelConfig struct {
	// ServerAddr is the frps server address (hostname or IP).
	ServerAddr string
	// ServerPort is the frps server bind port.
	ServerPort int
	// Token is the frps authentication token.
	Token string
	// AccessKey is placed into frpc metadata for server-side plugin validation.
	AccessKey string
	// ProxyName is the unique name assigned to this proxy by the management server.
	ProxyName string
	// LocalIP is the local address to forward traffic to.
	LocalIP string
	// LocalPort is the local port to forward traffic to.
	LocalPort int
	// RemotePort is the public port allocated on the frps server.
	RemotePort int
}

// StartTunnel creates and runs an embedded frp client service.
// It sends status updates to statusCh and blocks until the context is cancelled
// or an unrecoverable error occurs.
//
// Log output from the frpc library is redirected to logCh as parsed LogEntry
// values so the TUI can display them without corrupting the alt screen.
//
// The tunnel is configured with LoginFailExit=false so that frpc will keep
// retrying the connection if the initial login fails (e.g. due to transient
// network issues). The frps server-side plugin uses the access_key metadata
// to validate the client on Login.
func StartTunnel(ctx context.Context, cfg TunnelConfig, statusCh chan<- StatusUpdate, logCh chan<- LogEntry) error {
	// Send initial connecting status.
	sendStatus(statusCh, StatusUpdate{
		Status:  StatusConnecting,
		Message: fmt.Sprintf("Connecting to %s:%d...", cfg.ServerAddr, cfg.ServerPort),
	})

	// Build the frp client common configuration.
	commonCfg := buildCommonConfig(cfg)

	// Build the TCP proxy configuration.
	proxyCfg := buildTCPProxyConfig(cfg)

	// Redirect the frpc global logger to our logWriter so that log output
	// is captured as structured entries instead of going to os.Stdout,
	// which would corrupt the Bubble Tea alt screen.
	frplog.Logger = frplog.Logger.WithOptions(goliblog.WithOutput(&logWriter{ch: logCh}))

	// Create the frp client service.
	svc, err := client.NewService(client.ServiceOptions{
		Common:    commonCfg,
		ProxyCfgs: []v1.ProxyConfigurer{proxyCfg},
	})
	if err != nil {
		sendStatus(statusCh, StatusUpdate{
			Status:  StatusError,
			Message: "Failed to create frp service",
			Error:   fmt.Errorf("failed to create frp service: %w", err),
		})
		return fmt.Errorf("failed to create frp service: %w", err)
	}

	// Notify that the service has been created and is now attempting to connect.
	sendStatus(statusCh, StatusUpdate{
		Status:  StatusConnecting,
		Message: fmt.Sprintf("Tunnel service started, proxy=%s, remote port=%d", cfg.ProxyName, cfg.RemotePort),
	})

	// Run the service. This blocks until ctx is cancelled or an error occurs.
	// With LoginFailExit=false, the service will retry connections internally.
	err = svc.Run(ctx)

	// When we reach here, the service has stopped.
	if err != nil {
		// Check if the context was cancelled (graceful shutdown).
		if ctx.Err() != nil {
			sendStatus(statusCh, StatusUpdate{
				Status:  StatusClosed,
				Message: "Tunnel closed",
			})
			return nil
		}
		sendStatus(statusCh, StatusUpdate{
			Status:  StatusError,
			Message: "Tunnel service exited with error",
			Error:   err,
		})
		return fmt.Errorf("frp service error: %w", err)
	}

	sendStatus(statusCh, StatusUpdate{
		Status:  StatusClosed,
		Message: "Tunnel closed",
	})
	return nil
}

// buildCommonConfig constructs the frp ClientCommonConfig from our TunnelConfig.
func buildCommonConfig(cfg TunnelConfig) *v1.ClientCommonConfig {
	commonCfg := &v1.ClientCommonConfig{}
	commonCfg.ServerAddr = cfg.ServerAddr
	commonCfg.ServerPort = cfg.ServerPort

	// Authentication using token method.
	commonCfg.Auth.Method = v1.AuthMethodToken
	commonCfg.Auth.Token = cfg.Token

	// Embed the access key in metadata so the frps server-side plugin
	// can validate the client on Login.
	commonCfg.Metadatas = map[string]string{
		"access_key": cfg.AccessKey,
	}

	// Disable LoginFailExit so the client keeps retrying on connection failure.
	// This allows automatic reconnection when the server is temporarily unavailable.
	commonCfg.LoginFailExit = lo.ToPtr(false)

	// Use default log settings (console output, info level).
	commonCfg.Log.To = "console"
	commonCfg.Log.Level = "info"

	return commonCfg
}

// buildTCPProxyConfig constructs the frp TCPProxyConfig from our TunnelConfig.
func buildTCPProxyConfig(cfg TunnelConfig) *v1.TCPProxyConfig {
	proxyCfg := &v1.TCPProxyConfig{}
	proxyCfg.Name = cfg.ProxyName
	proxyCfg.Type = string(v1.ProxyTypeTCP)
	proxyCfg.LocalIP = cfg.LocalIP
	proxyCfg.LocalPort = cfg.LocalPort
	proxyCfg.RemotePort = cfg.RemotePort
	return proxyCfg
}

// sendStatus safely sends a status update to the channel.
// It is non-blocking; if the channel is full the update is dropped.
func sendStatus(ch chan<- StatusUpdate, update StatusUpdate) {
	select {
	case ch <- update:
	default:
		// Channel full, drop the update to avoid blocking the tunnel goroutine.
	}
}
