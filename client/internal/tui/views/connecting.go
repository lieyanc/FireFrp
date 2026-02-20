package views

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/AerNos/firefrp-client/internal/tui/theme"
)

// ConnectPhase indicates the current stage of the connection process.
type ConnectPhase int

const (
	PhaseValidating ConnectPhase = iota // Validating the access key with the API.
	PhaseConnecting                     // Establishing the frpc tunnel.
)

// CancelConnectMsg is emitted when the user cancels during connection.
type CancelConnectMsg struct{}

// ConnectingModel is the Bubble Tea model for the "connecting" spinner view.
type ConnectingModel struct {
	spinner    spinner.Model
	phase      ConnectPhase
	key        string // Access key (will be partially masked).
	localPort  int
	remotePort int
	serverName string
	width      int
	height     int
}

// NewConnectingModel creates a ConnectingModel for the given key and ports.
func NewConnectingModel(key string, localPort int, serverName string) ConnectingModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = theme.SpinnerStyle

	return ConnectingModel{
		spinner:    s,
		phase:      PhaseValidating,
		key:        key,
		localPort:  localPort,
		serverName: serverName,
	}
}

// Init starts the spinner animation.
func (m ConnectingModel) Init() tea.Cmd {
	return m.spinner.Tick
}

// SetPhase updates the displayed phase (Validating / Connecting).
func (m *ConnectingModel) SetPhase(p ConnectPhase) {
	m.phase = p
}

// SetRemotePort stores the remote port once known from the API response.
func (m *ConnectingModel) SetRemotePort(port int) {
	m.remotePort = port
}

// Update handles messages for the connecting view.
func (m ConnectingModel) Update(msg tea.Msg) (ConnectingModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			return m, func() tea.Msg {
				return CancelConnectMsg{}
			}
		}

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	return m, nil
}

// View renders the connecting spinner view.
func (m ConnectingModel) View() string {
	var b strings.Builder

	// Brand header.
	b.WriteString(theme.BrandText())
	b.WriteString("\n\n")

	// Spinner + phase message.
	var phaseText string
	switch m.phase {
	case PhaseValidating:
		phaseText = "正在验证 Access Key..."
	case PhaseConnecting:
		phaseText = "正在建立隧道连接..."
	}
	b.WriteString("  " + m.spinner.View() + " " + phaseText)
	b.WriteString("\n\n")

	// Connection details.
	b.WriteString("  " + theme.LabelStyle.Render("服务器:") + " " + theme.ValueStyle.Render(m.serverName))
	b.WriteString("\n")
	b.WriteString("  " + theme.LabelStyle.Render("Key:") + " " + theme.ValueStyle.Render(MaskKey(m.key)))
	b.WriteString("\n")
	if m.remotePort > 0 {
		b.WriteString("  " + theme.LabelStyle.Render("端口:") + " " + theme.ValueStyle.Render(FmtPort(m.localPort, m.remotePort)))
	} else {
		b.WriteString("  " + theme.LabelStyle.Render("本地端口:") + " " + theme.ValueStyle.Render(fmt.Sprintf("%d", m.localPort)))
	}

	// Help bar.
	b.WriteString("\n\n")
	b.WriteString(theme.HelpStyle.Render("         [Esc] 取消"))

	content := b.String()
	return theme.AppBoxStyle.Render(content)
}
