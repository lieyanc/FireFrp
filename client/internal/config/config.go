// Package config handles CLI flag parsing and application configuration.
package config

import (
	"flag"
	"fmt"
	"os"
)

// Config holds the runtime configuration for the FireFrp client.
type Config struct {
	// ServerListURL is the URL of a remote JSON file containing the server list.
	// Each entry only contains an apiUrl field; details are fetched from each server.
	ServerListURL string

	// ServerURL is the FireFrp management API address.
	// Default: http://localhost:9001
	ServerURL string

	// AccessKey is the user-provided access key for tunnel authentication.
	AccessKey string

	// LocalPort is the local port to be mapped through the tunnel.
	LocalPort int

	// LocalIP is the local IP address to bind to.
	// Default: 127.0.0.1
	LocalIP string

	// ShowVersion prints version and exits.
	ShowVersion bool
}

// DirectMode returns true if both AccessKey and LocalPort are provided,
// indicating the client should skip TUI and connect directly.
func (c *Config) DirectMode() bool {
	return c.AccessKey != "" && c.LocalPort > 0
}

// NeedsServerSelect returns true if a server list URL is configured,
// indicating the TUI should show the server selection view first.
func (c *Config) NeedsServerSelect() bool {
	return c.ServerListURL != ""
}

// Validate checks the config for logical errors when used in direct mode.
func (c *Config) Validate() error {
	if c.DirectMode() {
		if c.LocalPort < 1 || c.LocalPort > 65535 {
			return fmt.Errorf("invalid local port: %d (must be 1-65535)", c.LocalPort)
		}
	}
	return nil
}

// ParseFlags parses command-line flags and returns a Config.
// If --key and --port are both provided, the client enters direct connect mode
// (skipping the TUI). Otherwise, it starts in TUI mode.
func ParseFlags() *Config {
	cfg := &Config{}

	flag.StringVar(&cfg.ServerListURL, "server-list", "https://static.lieyan.work/project/FireFrp/config/server-list.json", "Remote server list JSON URL (hosted on object storage)")
	flag.StringVar(&cfg.ServerURL, "server", "http://localhost:9001", "FireFrp management API URL")
	flag.StringVar(&cfg.AccessKey, "key", "", "Access key for tunnel authentication")
	flag.IntVar(&cfg.LocalPort, "port", 0, "Local port to map through the tunnel")
	flag.StringVar(&cfg.LocalIP, "local-ip", "127.0.0.1", "Local IP address to bind to")
	flag.BoolVar(&cfg.ShowVersion, "version", false, "Print version and exit")

	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "FireFrp Client - TCP tunnel powered by frp\n\n")
		fmt.Fprintf(os.Stderr, "Usage:\n")
		fmt.Fprintf(os.Stderr, "  firefrp [flags]\n\n")
		fmt.Fprintf(os.Stderr, "Examples:\n")
		fmt.Fprintf(os.Stderr, "  firefrp                                    # Start in TUI mode\n")
		fmt.Fprintf(os.Stderr, "  firefrp --server-list https://cdn.example.com/servers.json\n")
		fmt.Fprintf(os.Stderr, "                                             # TUI mode with server selection\n")
		fmt.Fprintf(os.Stderr, "  firefrp --key ff-abc123 --port 25565       # Direct connect mode\n")
		fmt.Fprintf(os.Stderr, "  firefrp --server https://api.example.com   # Custom server URL\n")
		fmt.Fprintf(os.Stderr, "  firefrp --version                          # Print version\n\n")
		fmt.Fprintf(os.Stderr, "Flags:\n")
		flag.PrintDefaults()
	}

	flag.Parse()
	return cfg
}
