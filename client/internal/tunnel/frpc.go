// Package tunnel manages embedded frp client (frpc) connections.
// It builds frp client configurations and starts TCP tunnel services
// using the frp client library (v0.67.0).
package tunnel

import (
	"context"
	"fmt"

	"github.com/fatedier/frp/client"
	v1 "github.com/fatedier/frp/pkg/config/v1"
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
// The tunnel is configured with LoginFailExit=false so that frpc will keep
// retrying the connection if the initial login fails (e.g. due to transient
// network issues). The frps server-side plugin uses the access_key metadata
// to validate the client on Login.
func StartTunnel(ctx context.Context, cfg TunnelConfig, statusCh chan<- StatusUpdate) error {
	// Send initial connecting status.
	sendStatus(statusCh, StatusUpdate{
		Status:  StatusConnecting,
		Message: fmt.Sprintf("Connecting to %s:%d...", cfg.ServerAddr, cfg.ServerPort),
	})

	// Build the frp client common configuration.
	commonCfg := buildCommonConfig(cfg)

	// Build the TCP proxy configuration.
	proxyCfg := buildTCPProxyConfig(cfg)

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
