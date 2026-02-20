package views

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
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

// logEntry holds a single parsed log line for display in the TUI.
type logEntry struct {
	time    string
	level   string
	message string
}

// RunningModel is the Bubble Tea model for the "tunnel running" view.
type RunningModel struct {
	serverName string
	remoteAddr string
	localAddr  string
	expiresAt  time.Time
	startedAt  time.Time
	status     ConnectionStatus
	statusText string
	width      int
	height     int
	logEntries []logEntry
	maxLogs    int
}

// NewRunningModel creates a RunningModel with the supplied connection info.
func NewRunningModel(serverName, remoteAddr, localAddr string, expiresAt time.Time) RunningModel {
	return RunningModel{
		serverName: serverName,
		remoteAddr: remoteAddr,
		localAddr:  localAddr,
		expiresAt:  expiresAt,
		startedAt:  time.Now(),
		status:     StatusConnected,
		statusText: "已连接",
		maxLogs:    100,
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

// AddLog appends a log entry and trims to maxLogs.
func (m *RunningModel) AddLog(t, level, msg string) {
	m.logEntries = append(m.logEntries, logEntry{time: t, level: level, message: msg})
	if len(m.logEntries) > m.maxLogs {
		m.logEntries = m.logEntries[len(m.logEntries)-m.maxLogs:]
	}
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
	// Determine dynamic content width.
	// AppBoxStyle adds border (2) + padding (3*2=6) = 8 chars of chrome.
	const chromeWidth = 8
	contentWidth := 62 // default
	if m.width > 0 {
		w := m.width - chromeWidth
		if w < 40 {
			w = 40
		}
		if w > 92 {
			w = 92
		}
		contentWidth = w
	}
	boxWidth := contentWidth + chromeWidth

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

	// Calculate remaining time until expiry.
	remaining := time.Until(m.expiresAt)
	var remainingText string
	if remaining <= 0 {
		remainingText = theme.ErrorStyle.Render("已过期")
	} else {
		remainingText = formatDuration(remaining)
	}

	info := strings.Join([]string{
		theme.LabelStyle.Render("服务器:") + "  " + theme.ValueStyle.Render(m.serverName),
		theme.LabelStyle.Render("远程地址:") + " " + theme.ValueStyle.Render(m.remoteAddr),
		theme.LabelStyle.Render("本地映射:") + " " + theme.ValueStyle.Render(m.localAddr),
		theme.LabelStyle.Render("到期时间:") + " " + theme.ValueStyle.Render(m.expiresAt.Format("2006-01-02 15:04:05")),
		theme.LabelStyle.Render("剩余时间:") + " " + theme.ValueStyle.Render(remainingText),
		theme.LabelStyle.Render("运行时长:") + " " + theme.ValueStyle.Render(formatDuration(time.Since(m.startedAt))),
	}, "\n")
	boxContent := infoTitle + "\n" + info
	box := theme.BoxStyle.Render(boxContent)
	b.WriteString(box)

	// Log panel.
	b.WriteString("\n")
	b.WriteString(m.renderLogPanel(contentWidth))

	// Status + help on a single line at the bottom.
	b.WriteString("\n")
	var statusLine string
	switch m.status {
	case StatusConnected:
		statusLine = "状态: " + theme.SuccessStyle.Render("已连接 ✓")
	case StatusReconnecting:
		statusLine = "状态: " + theme.WarningStyle.Render("重连中...")
	case StatusError:
		statusLine = "状态: " + theme.ErrorStyle.Render(m.statusText)
	}
	helpText := theme.HelpStyle.Render("[Q] 断开并退出")
	b.WriteString("  " + statusLine + "  " + helpText)

	content := b.String()
	return theme.AppBoxStyle.Copy().Width(boxWidth).Render(content)
}

// renderLogPanel builds the log display box.
func (m RunningModel) renderLogPanel(contentWidth int) string {
	// Calculate visible log lines based on terminal height.
	visibleLogs := 8
	if m.height > 0 {
		// Reserve space for header (~4), info box (~8), status line (1), AppBox chrome (4).
		available := m.height - 17
		if available < 3 {
			available = 3
		}
		if available > 16 {
			available = 16
		}
		visibleLogs = available
	}

	// LogBoxStyle adds border (2) + padding (1*2=2) = 4 chars of horizontal chrome.
	const logChromeWidth = 4
	logContentWidth := contentWidth - logChromeWidth
	if logContentWidth < 20 {
		logContentWidth = 20
	}

	logTitle := theme.BoxTitleStyle.Render("日志")

	var lines []string
	start := 0
	if len(m.logEntries) > visibleLogs {
		start = len(m.logEntries) - visibleLogs
	}
	for _, e := range m.logEntries[start:] {
		lines = append(lines, m.formatLogLine(e, logContentWidth))
	}

	// If no logs yet, show a placeholder.
	if len(lines) == 0 {
		lines = append(lines, theme.LogTimeStyle.Render("等待日志..."))
	}

	logBody := logTitle + "\n" + strings.Join(lines, "\n")
	return theme.LogBoxStyle.Copy().Width(contentWidth).Render(logBody)
}

// formatLogLine formats a single log entry with colored level indicator.
func (m RunningModel) formatLogLine(e logEntry, maxWidth int) string {
	// Format: "HH:MM:SS [L] message"
	timeStr := theme.LogTimeStyle.Render(e.time)

	var levelStr string
	switch e.level {
	case "W":
		levelStr = theme.LogLevelWarn.Render("[W]")
	case "E":
		levelStr = theme.LogLevelError.Render("[E]")
	default:
		levelStr = theme.LogTimeStyle.Render("[" + e.level + "]")
	}

	// "HH:MM:SS" (8) + " " (1) + "[L]" (3) + " " (1) = 13 chars of prefix.
	msgMaxWidth := maxWidth - 13
	msg := e.message
	if msgMaxWidth > 0 && lipgloss.Width(msg) > msgMaxWidth {
		// Truncate the message to fit.
		if msgMaxWidth > 3 {
			msg = msg[:msgMaxWidth-3] + "..."
		} else {
			msg = msg[:msgMaxWidth]
		}
	}

	return timeStr + " " + levelStr + " " + msg
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
