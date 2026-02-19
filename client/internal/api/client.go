// Package api provides an HTTP client for communicating with the FireFrp management server.
package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// ValidateResponse is the response from the POST /api/v1/validate endpoint.
type ValidateResponse struct {
	OK    bool          `json:"ok"`
	Data  *ValidateData `json:"data,omitempty"`
	Error *ErrorInfo    `json:"error,omitempty"`
}

// ValidateData contains the frps connection parameters returned on successful validation.
type ValidateData struct {
	FrpsAddr   string `json:"frps_addr"`
	FrpsPort   int    `json:"frps_port"`
	RemotePort int    `json:"remote_port"`
	Token      string `json:"token"`
	ProxyName  string `json:"proxy_name"`
	ExpiresAt  string `json:"expires_at"`
}

// ErrorInfo describes an error returned by the server.
type ErrorInfo struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// validateRequest is the request body for the validate endpoint.
type validateRequest struct {
	Key string `json:"key"`
}

// APIClient handles HTTP communication with the FireFrp management server.
type APIClient struct {
	baseURL    string
	httpClient *http.Client
}

// NewAPIClient creates a new APIClient with the given server base URL.
func NewAPIClient(baseURL string) *APIClient {
	return &APIClient{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 15 * time.Second,
		},
	}
}

// Validate sends an access key to the server for validation and returns
// the frps connection parameters on success.
// Endpoint: POST /api/v1/validate
func (c *APIClient) Validate(key string) (*ValidateResponse, error) {
	reqBody := validateRequest{Key: key}
	bodyBytes, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal request body: %w", err)
	}

	url := c.baseURL + "/api/v1/validate"
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send request to %s: %w", url, err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read response body: %w", err)
	}

	// Parse the response regardless of HTTP status code,
	// since the server uses the JSON body to communicate errors.
	var validateResp ValidateResponse
	if err := json.Unmarshal(respBody, &validateResp); err != nil {
		return nil, fmt.Errorf("failed to parse response (status %d): %w", resp.StatusCode, err)
	}

	// If HTTP status indicates a server error and the JSON body doesn't have error info,
	// create a generic error.
	if resp.StatusCode >= 500 && validateResp.Error == nil {
		return nil, fmt.Errorf("server error: HTTP %d", resp.StatusCode)
	}

	return &validateResp, nil
}
