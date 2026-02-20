package api

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ServerListEntry represents a single entry in the remote server list JSON.
// The file hosted on object storage only contains apiUrl; all other details
// are fetched from each server's /api/v1/server-info endpoint.
type ServerListEntry struct {
	APIUrl string `json:"apiUrl"`
}

// ServerInfo holds the self-configuration returned by a server's
// GET /api/v1/server-info endpoint.
type ServerInfo struct {
	ID            string `json:"id"`
	Name          string `json:"name"`
	PublicAddr    string `json:"public_addr"`
	Description   string `json:"description"`
	ClientVersion string `json:"client_version"`
	APIUrl        string `json:"-"` // set locally, not from JSON
}

// serverInfoResponse wraps the API response.
type serverInfoResponse struct {
	OK   bool        `json:"ok"`
	Data *ServerInfo `json:"data,omitempty"`
}

// FetchServerList downloads and parses the server list JSON from the given URL.
func FetchServerList(url string) ([]ServerListEntry, error) {
	client := &http.Client{Timeout: 10 * time.Second}

	resp, err := client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch server list: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read server list response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("server list returned HTTP %d", resp.StatusCode)
	}

	var entries []ServerListEntry
	if err := json.Unmarshal(body, &entries); err != nil {
		return nil, fmt.Errorf("failed to parse server list JSON: %w", err)
	}

	return entries, nil
}

// FetchServerInfo queries the server's /api/v1/server-info endpoint
// and returns the server's self-configuration.
func (c *APIClient) FetchServerInfo() (*ServerInfo, error) {
	url := c.baseURL + "/api/v1/server-info"

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch server info from %s: %w", url, err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read server info response: %w", err)
	}

	var result serverInfoResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return nil, fmt.Errorf("failed to parse server info JSON: %w", err)
	}

	if !result.OK || result.Data == nil {
		return nil, fmt.Errorf("server info response not ok")
	}

	return result.Data, nil
}
