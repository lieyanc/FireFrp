package views

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/AerNos/firefrp-client/internal/tui/theme"
)

// ConnectionStatus represents the current tunnel connection state.
type ConnectionStatus int

const (
	StatusConnected    ConnectionStatus = iota // Tunnel is healthy.
	StatusReconnecting                         // Tunnel is attempting to reconnect.
	StatusError                                // Tunnel encountered an error.
)

// tickMsg is sent periodically to update the uptime counter.
type tickMsg time.Time

// RunningModel is the Bubble Tea model for the "tunnel running" view.
type RunningModel struct {
	remoteAddr string
	localAddr  string
	expiresAt  time.Time
	startedAt  time.Time
	status     ConnectionStatus
	statusText string
	width      int
	height     int
}

// NewRunningModel creates a RunningModel with the supplied connection info.
func NewRunningModel(remoteAddr, localAddr string, expiresAt time.Time) RunningModel {
	return RunningModel{
		remoteAddr: remoteAddr,
		localAddr:  localAddr,
		expiresAt:  expiresAt,
		startedAt:  time.Now(),
		status:     StatusConnected,
		statusText: "已连接",
	}
}

// Init starts the periodic tick for uptime updates (every second).
func (m RunningModel) Init() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

// SetStatus updates the displayed connection status.
func (m *RunningModel) SetStatus(s ConnectionStatus, text string) {
	m.status = s
	m.statusText = text
}

// Update handles messages for the running view.
func (m RunningModel) Update(msg tea.Msg) (RunningModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		}

	case tickMsg:
		// Re-schedule the next tick.
		return m, tea.Tick(time.Second, func(t time.Time) tea.Msg {
			return tickMsg(t)
		})
	}

	return m, nil
}

// View renders the running tunnel status view.
func (m RunningModel) View() string {
	var b strings.Builder

	// Brand header.
	b.WriteString(theme.BrandText())
	b.WriteString("\n\n")

	// Status indicator line.
	switch m.status {
	case StatusConnected:
		b.WriteString("  " + theme.DotConnected + " " + theme.SuccessStyle.Render("隧道已建立"))
	case StatusReconnecting:
		b.WriteString("  " + theme.DotReconnecting + " " + theme.WarningStyle.Render("正在重连..."))
	case StatusError:
		b.WriteString("  " + theme.DotError + " " + theme.ErrorStyle.Render("连接异常"))
	}
	b.WriteString("\n")

	// Connection info box.
	infoTitle := theme.BoxTitleStyle.Render("连接信息")
	info := strings.Join([]string{
		theme.LabelStyle.Render("远程地址:") + " " + theme.ValueStyle.Render(m.remoteAddr),
		theme.LabelStyle.Render("本地映射:") + " " + theme.ValueStyle.Render(m.localAddr),
		theme.LabelStyle.Render("到期时间:") + " " + theme.ValueStyle.Render(m.expiresAt.Format("2006-01-02 15:04")),
		theme.LabelStyle.Render("运行时长:") + " " + theme.ValueStyle.Render(formatDuration(time.Since(m.startedAt))),
	}, "\n")
	boxContent := infoTitle + "\n" + info
	box := theme.BoxStyle.Render(boxContent)
	b.WriteString(box)
	b.WriteString("\n")

	// Status footer.
	var statusLine string
	switch m.status {
	case StatusConnected:
		statusLine = "状态: " + theme.SuccessStyle.Render("已连接 ✓")
	case StatusReconnecting:
		statusLine = "状态: " + theme.WarningStyle.Render("重连中...")
	case StatusError:
		statusLine = "状态: " + theme.ErrorStyle.Render(m.statusText)
	}
	b.WriteString("  " + statusLine)

	// Help bar.
	b.WriteString("\n")
	b.WriteString(theme.HelpStyle.Render("       [Q] 断开并退出"))

	content := b.String()
	return theme.AppBoxStyle.Render(content)
}

// Uptime returns the duration since the tunnel was started.
func (m RunningModel) Uptime() time.Duration {
	return time.Since(m.startedAt)
}

// formatDuration formats a duration as HH:MM:SS.
func formatDuration(d time.Duration) string {
	d = d.Round(time.Second)
	h := int(d.Hours())
	m := int(d.Minutes()) % 60
	s := int(d.Seconds()) % 60
	return fmt.Sprintf("%02d:%02d:%02d", h, m, s)
}

// statusDot returns the colored dot for the given status. Kept as a helper
// so it can be reused from AppModel if needed.
func StatusDot(s ConnectionStatus) string {
	switch s {
	case StatusConnected:
		return theme.DotConnected
	case StatusReconnecting:
		return theme.DotReconnecting
	case StatusError:
		return theme.DotError
	default:
		return theme.DotError
	}
}

// TickMsg re-exports tickMsg for type-assertion in AppModel.Update.
func IsTickMsg(msg tea.Msg) bool {
	_, ok := msg.(tickMsg)
	return ok
}

// NewTickCmd creates a 1-second tick command (used by AppModel to forward
// tick scheduling when wrapping the running view).
func NewTickCmd() tea.Cmd {
	return tea.Tick(time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}
