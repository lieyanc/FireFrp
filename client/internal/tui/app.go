package tui

import (
	"context"
	"fmt"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/AerNos/firefrp-client/internal/api"
	"github.com/AerNos/firefrp-client/internal/config"
	"github.com/AerNos/firefrp-client/internal/tui/views"
	"github.com/AerNos/firefrp-client/internal/tunnel"
)

// appState enumerates the top-level application states.
type appState int

const (
	stateServerSelect appState = iota // Selecting a server from the list.
	stateInput                        // Waiting for user input.
	stateConnecting                   // Validating key / establishing tunnel.
	stateRunning                      // Tunnel is active.
	stateError                        // An error occurred; user can retry.
)

// ---------------------------------------------------------------------------
// Internal message types exchanged between the state machine and async tasks.
// ---------------------------------------------------------------------------

// validateResultMsg carries the API validation response.
type validateResultMsg struct {
	resp *api.ValidateResponse
	err  error
}

// tunnelStatusMsg carries a tunnel status update from the frpc goroutine.
type tunnelStatusMsg struct {
	update tunnel.StatusUpdate
}

// logMsg carries a frpc log entry to be displayed in the running view.
type logMsg struct {
	entry tunnel.LogEntry
}

// errorMsg carries an error to be displayed.
type errorMsg struct {
	err error
}

// ---------------------------------------------------------------------------
// AppModel
// ---------------------------------------------------------------------------

// AppModel is the top-level Bubble Tea model that orchestrates the state
// machine: ServerSelect -> Input -> Connecting -> Running -> (Error -> Input).
type AppModel struct {
	state            appState
	serverSelectView views.ServerSelectModel
	inputView        views.InputModel
	connectView      views.ConnectingModel
	runningView      views.RunningModel

	// Dependencies injected via Run().
	config    *config.Config
	apiClient *api.APIClient

	// Tunnel runtime state.
	tunnelCfg   *tunnel.TunnelConfig
	statusCh    chan tunnel.StatusUpdate
	logCh       chan tunnel.LogEntry
	pendingLogs []tunnel.LogEntry
	cancelFn    context.CancelFunc

	// Submitted values (kept for retry).
	submittedKey  string
	submittedPort int

	// ExpiresAt from the API validation response, stored so the running view
	// can display it once the tunnel is established.
	expiresAt time.Time

	err error
}

// newAppModel initialises the application model with the given config.
func newAppModel(cfg *config.Config) AppModel {
	m := AppModel{
		inputView: views.NewInputModel(),
		config:    cfg,
	}

	if cfg.NeedsServerSelect() {
		// Start with server selection
		m.state = stateServerSelect
		m.serverSelectView = views.NewServerSelectModel(cfg.ServerListURL)
	} else {
		// Skip server selection, use the configured server URL directly
		m.state = stateInput
		m.apiClient = api.NewAPIClient(cfg.ServerURL)
	}

	return m
}

// Init returns the initial command (delegate to the active sub-view).
func (m AppModel) Init() tea.Cmd {
	if m.state == stateServerSelect {
		return m.serverSelectView.Init()
	}
	return m.inputView.Init()
}

// Update implements tea.Model. It routes messages to the appropriate sub-view
// based on the current state and handles state transitions.
func (m AppModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	// -- Global key handling -----------------------------------------------
	case tea.KeyMsg:
		// Ctrl+C always quits regardless of state.
		if msg.String() == "ctrl+c" {
			m.cleanup()
			return m, tea.Quit
		}

	// -- Window resize -----------------------------------------------------
	case tea.WindowSizeMsg:
		// Forward to all sub-views so they can adapt.
		m.serverSelectView, _ = m.serverSelectView.Update(msg)
		m.inputView, _ = m.inputView.Update(msg)
		m.connectView, _ = m.connectView.Update(msg)
		m.runningView, _ = m.runningView.Update(msg)
		return m, nil

	// -- Server selected from the selection view ---------------------------
	case views.ServerSelectedMsg:
		m.apiClient = api.NewAPIClient(msg.APIUrl)
		m.state = stateInput
		return m, m.inputView.Init()

	// -- User submits key + port from the input view -----------------------
	case views.SubmitMsg:
		m.submittedKey = msg.Key
		m.submittedPort = msg.Port

		// Transition to Connecting (validation phase).
		m.connectView = views.NewConnectingModel(msg.Key, msg.Port)
		m.state = stateConnecting

		return m, tea.Batch(
			m.connectView.Init(),
			m.validateKey(msg.Key),
		)

	// -- API validation result ---------------------------------------------
	case validateResultMsg:
		if msg.err != nil {
			m.err = msg.err
			m.inputView.SetError(msg.err.Error())
			m.state = stateInput
			return m, m.inputView.Init()
		}
		// Check if the server returned an error in the response body.
		if !msg.resp.OK {
			errText := "验证失败"
			if msg.resp.Error != nil {
				errText = mapErrorCode(msg.resp.Error.Code, msg.resp.Error.Message)
			}
			m.inputView.SetError(errText)
			m.state = stateInput
			return m, m.inputView.Init()
		}
		// Validation succeeded. Update the connecting view and start tunnel.
		m.connectView.SetPhase(views.PhaseConnecting)
		m.connectView.SetRemotePort(msg.resp.Data.RemotePort)

		// Parse and store the expiration time.
		if t, err := time.Parse(time.RFC3339, msg.resp.Data.ExpiresAt); err == nil {
			m.expiresAt = t
		}

		return m, m.startTunnel(msg.resp.Data)

	// -- Tunnel status updates ---------------------------------------------
	case tunnelStatusMsg:
		return m.handleTunnelStatus(msg.update)

	// -- Tunnel log entries ------------------------------------------------
	case logMsg:
		switch m.state {
		case stateConnecting:
			m.pendingLogs = append(m.pendingLogs, msg.entry)
		case stateRunning:
			m.runningView.AddLog(msg.entry.Time, msg.entry.Level, msg.entry.Message)
		}
		// Always keep consuming logs as long as the channel is open.
		return m, m.waitForLog()

	// -- Cancel during connection ------------------------------------------
	case views.CancelConnectMsg:
		m.cleanup()
		m.state = stateInput
		m.inputView.ClearError()
		return m, m.inputView.Init()

	// -- Generic error -----------------------------------------------------
	case errorMsg:
		m.err = msg.err
		m.inputView.SetError(msg.err.Error())
		m.state = stateInput
		return m, m.inputView.Init()
	}

	// -- Delegate to the active sub-view -----------------------------------
	var cmd tea.Cmd
	switch m.state {
	case stateServerSelect:
		m.serverSelectView, cmd = m.serverSelectView.Update(msg)
	case stateInput:
		m.inputView, cmd = m.inputView.Update(msg)
	case stateConnecting:
		m.connectView, cmd = m.connectView.Update(msg)
	case stateRunning:
		m.runningView, cmd = m.runningView.Update(msg)
	}
	return m, cmd
}

// View implements tea.Model. It renders the active sub-view.
func (m AppModel) View() string {
	switch m.state {
	case stateServerSelect:
		return m.serverSelectView.View()
	case stateInput, stateError:
		return m.inputView.View()
	case stateConnecting:
		return m.connectView.View()
	case stateRunning:
		return m.runningView.View()
	default:
		return ""
	}
}

// ---------------------------------------------------------------------------
// Async commands
// ---------------------------------------------------------------------------

// validateKey returns a tea.Cmd that calls the API to validate the access key.
func (m *AppModel) validateKey(key string) tea.Cmd {
	c := m.apiClient
	return func() tea.Msg {
		resp, err := c.Validate(key)
		return validateResultMsg{resp: resp, err: err}
	}
}

// startTunnel returns a tea.Cmd that starts the frpc tunnel in a background
// goroutine and feeds status updates back into the Bubble Tea event loop.
func (m *AppModel) startTunnel(data *api.ValidateData) tea.Cmd {
	cfg := &tunnel.TunnelConfig{
		ServerAddr: data.FrpsAddr,
		ServerPort: data.FrpsPort,
		Token:      data.Token,
		ProxyName:  data.ProxyName,
		LocalIP:    m.config.LocalIP,
		LocalPort:  m.submittedPort,
		RemotePort: data.RemotePort,
		AccessKey:  m.submittedKey,
	}
	m.tunnelCfg = cfg

	statusCh := make(chan tunnel.StatusUpdate, 16)
	m.statusCh = statusCh

	logCh := make(chan tunnel.LogEntry, 64)
	m.logCh = logCh

	ctx, cancel := context.WithCancel(context.Background())
	m.cancelFn = cancel

	// Start tunnel in background goroutine.
	go func() {
		_ = tunnel.StartTunnel(ctx, *cfg, statusCh, logCh)
		close(statusCh)
		close(logCh)
	}()

	// Return commands that wait for both status updates and log entries.
	return tea.Batch(m.waitForStatus(), m.waitForLog())
}

// waitForStatus returns a tea.Cmd that reads the next status update from the
// channel and wraps it into a tunnelStatusMsg.
func (m *AppModel) waitForStatus() tea.Cmd {
	ch := m.statusCh
	if ch == nil {
		return nil
	}
	return func() tea.Msg {
		update, ok := <-ch
		if !ok {
			return errorMsg{err: fmt.Errorf("隧道连接已关闭")}
		}
		return tunnelStatusMsg{update: update}
	}
}

// waitForLog returns a tea.Cmd that reads the next log entry from the
// channel and wraps it into a logMsg.
func (m *AppModel) waitForLog() tea.Cmd {
	ch := m.logCh
	if ch == nil {
		return nil
	}
	return func() tea.Msg {
		entry, ok := <-ch
		if !ok {
			return nil
		}
		return logMsg{entry: entry}
	}
}

// handleTunnelStatus processes a tunnel status update and transitions state.
func (m AppModel) handleTunnelStatus(u tunnel.StatusUpdate) (tea.Model, tea.Cmd) {
	switch u.Status {
	case tunnel.StatusConnected:
		// Build the running view with connection details.
		remoteAddr := fmt.Sprintf("%s:%d", m.tunnelCfg.ServerAddr, m.tunnelCfg.RemotePort)
		localAddr := fmt.Sprintf("%s:%d", m.tunnelCfg.LocalIP, m.tunnelCfg.LocalPort)
		m.runningView = views.NewRunningModel(remoteAddr, localAddr, m.expiresAt)
		// Flush any log entries buffered during the connecting phase.
		for _, entry := range m.pendingLogs {
			m.runningView.AddLog(entry.Time, entry.Level, entry.Message)
		}
		m.pendingLogs = nil
		m.state = stateRunning
		return m, tea.Batch(m.runningView.Init(), m.waitForStatus())

	case tunnel.StatusReconnecting:
		if m.state == stateRunning {
			m.runningView.SetStatus(views.StatusReconnecting, "正在重连...")
		}
		return m, m.waitForStatus()

	case tunnel.StatusError:
		if m.state == stateRunning {
			m.runningView.SetStatus(views.StatusError, u.Message)
			return m, m.waitForStatus()
		}
		// If we haven't reached Running yet, fall back to input.
		m.err = fmt.Errorf("%s", u.Message)
		m.inputView.SetError(u.Message)
		m.state = stateInput
		m.cleanup()
		return m, m.inputView.Init()

	case tunnel.StatusRejected:
		m.cleanup()
		errMsg := "连接被服务器拒绝"
		if u.Message != "" {
			errMsg = u.Message
		}
		m.err = fmt.Errorf("%s", errMsg)
		m.inputView.SetError(errMsg)
		m.state = stateInput
		return m, m.inputView.Init()

	case tunnel.StatusClosed:
		m.cleanup()
		m.inputView.SetError("隧道已断开")
		m.state = stateInput
		return m, m.inputView.Init()
	}

	// Unknown / intermediate status: keep listening.
	return m, m.waitForStatus()
}

// cleanup cancels the tunnel context. The tunnel goroutine is responsible for
// closing the status and log channels after it exits.
func (m *AppModel) cleanup() {
	if m.cancelFn != nil {
		m.cancelFn()
		m.cancelFn = nil
	}
	m.logCh = nil
	m.pendingLogs = nil
}

// mapErrorCode translates a server error code into a user-friendly Chinese
// message. Falls back to the raw message if the code is unrecognized.
func mapErrorCode(code, message string) string {
	switch code {
	case "KEY_NOT_FOUND":
		return "Access Key 不存在，请检查输入"
	case "KEY_EXPIRED":
		return "Access Key 已过期，请重新获取"
	case "KEY_ALREADY_USED":
		return "Access Key 已被使用"
	case "KEY_REVOKED":
		return "Access Key 已被撤销"
	default:
		if message != "" {
			return message
		}
		return "验证失败 (" + code + ")"
	}
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Run starts the Bubble Tea TUI application. It blocks until the user exits.
func Run(cfg *config.Config) error {
	model := newAppModel(cfg)
	p := tea.NewProgram(model, tea.WithAltScreen())
	_, err := p.Run()
	return err
}
