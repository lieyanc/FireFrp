// Package main is the entry point for the FireFrp client binary.
// It supports two modes:
//   - Direct mode: when --key and --port are both provided, it validates
//     the key and starts the tunnel immediately.
//   - TUI mode: otherwise, it launches an interactive terminal UI.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/AerNos/firefrp-client/internal/api"
	"github.com/AerNos/firefrp-client/internal/config"
	"github.com/AerNos/firefrp-client/internal/tui"
	"github.com/AerNos/firefrp-client/internal/tunnel"
)

// version is set at build time via -ldflags "-X main.version=..."
var version = "dev"

func main() {
	cfg := config.ParseFlags()

	if cfg.ShowVersion {
		fmt.Printf("firefrp version %s\n", version)
		return
	}

	if err := cfg.Validate(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}

	if cfg.DirectMode() {
		// Direct connect mode: skip TUI, validate key and start tunnel.
		if err := runDirect(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	} else {
		// TUI mode: launch interactive terminal UI.
		if err := tui.Run(cfg); err != nil {
			fmt.Fprintf(os.Stderr, "Error: %v\n", err)
			os.Exit(1)
		}
	}
}

// runDirect handles the direct connect mode (no TUI).
// It validates the access key with the server, then starts the frp tunnel.
func runDirect(cfg *config.Config) error {
	fmt.Printf("FireFrp Client - Direct Mode\n")
	fmt.Printf("Server: %s\n", cfg.ServerURL)
	fmt.Printf("Local:  %s:%d\n\n", cfg.LocalIP, cfg.LocalPort)

	// Step 1: Validate the access key with the management server.
	fmt.Printf("Validating access key...\n")
	apiClient := api.NewAPIClient(cfg.ServerURL)
	resp, err := apiClient.Validate(cfg.AccessKey)
	if err != nil {
		return fmt.Errorf("failed to validate key: %w", err)
	}

	if !resp.OK {
		if resp.Error != nil {
			return fmt.Errorf("validation failed [%s]: %s", resp.Error.Code, resp.Error.Message)
		}
		return fmt.Errorf("validation failed: unknown error")
	}

	if resp.Data == nil {
		return fmt.Errorf("validation succeeded but no connection data returned")
	}

	data := resp.Data
	fmt.Printf("Key validated successfully!\n")
	fmt.Printf("  Remote: %s:%d -> localhost:%d\n", data.FrpsAddr, data.RemotePort, cfg.LocalPort)
	fmt.Printf("  Proxy:  %s\n", data.ProxyName)
	fmt.Printf("  Expires: %s\n\n", data.ExpiresAt)

	// Step 2: Set up context with signal handling for graceful shutdown.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		sig := <-sigCh
		fmt.Printf("\nReceived signal %v, shutting down...\n", sig)
		cancel()
	}()

	// Step 3: Build tunnel configuration from validation response.
	tunnelCfg := tunnel.TunnelConfig{
		ServerAddr: data.FrpsAddr,
		ServerPort: data.FrpsPort,
		Token:      data.Token,
		AccessKey:  cfg.AccessKey,
		ProxyName:  data.ProxyName,
		LocalIP:    cfg.LocalIP,
		LocalPort:  cfg.LocalPort,
		RemotePort: data.RemotePort,
	}

	// Step 4: Start the tunnel and monitor status updates.
	statusCh := make(chan tunnel.StatusUpdate, 16)
	logCh := make(chan tunnel.LogEntry, 64)

	// Monitor status updates in a separate goroutine.
	go monitorStatus(statusCh)

	// Drain log entries in a separate goroutine (CLI mode prints to stdout anyway).
	go func() {
		for range logCh {
		}
	}()

	// StartTunnel blocks until context is cancelled or an error occurs.
	fmt.Printf("Starting tunnel...\n")
	return tunnel.StartTunnel(ctx, tunnelCfg, statusCh, logCh)
}

// monitorStatus reads status updates from the tunnel and prints them to stdout.
func monitorStatus(statusCh <-chan tunnel.StatusUpdate) {
	for update := range statusCh {
		switch update.Status {
		case tunnel.StatusConnecting:
			fmt.Printf("[CONNECTING] %s\n", update.Message)
		case tunnel.StatusConnected:
			fmt.Printf("[CONNECTED]  %s\n", update.Message)
		case tunnel.StatusReconnecting:
			fmt.Printf("[RECONNECT]  %s\n", update.Message)
		case tunnel.StatusRejected:
			fmt.Printf("[REJECTED]   %s\n", update.Message)
		case tunnel.StatusError:
			if update.Error != nil {
				fmt.Printf("[ERROR]      %s: %v\n", update.Message, update.Error)
			} else {
				fmt.Printf("[ERROR]      %s\n", update.Message)
			}
		case tunnel.StatusClosed:
			fmt.Printf("[CLOSED]     %s\n", update.Message)
			return
		}
	}
}
