package views

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/AerNos/firefrp-client/internal/tui/theme"
)

// SubmitMsg is emitted when the user submits valid key + port values.
type SubmitMsg struct {
	Key  string
	Port int
}

// InputModel is the Bubble Tea model for the access key + port input view.
type InputModel struct {
	keyInput   textinput.Model
	portInput  textinput.Model
	focusIndex int // 0 = key, 1 = port
	err        string
	updateHint string // non-empty when a dev update is available
	width      int
	height     int
}

// NewInputModel creates an InputModel with pre-configured text inputs.
func NewInputModel() InputModel {
	ki := textinput.New()
	ki.Placeholder = "输入 Access Key (ff-...)"
	ki.CharLimit = 64
	ki.Width = 36
	ki.PromptStyle = lipgloss.NewStyle().Foreground(theme.ColorPrimary)
	ki.TextStyle = lipgloss.NewStyle().Foreground(theme.ColorText)
	ki.PlaceholderStyle = lipgloss.NewStyle().Foreground(theme.ColorTextDim)
	ki.Focus()

	pi := textinput.New()
	pi.Placeholder = "本地端口 (如 25565)"
	pi.CharLimit = 5
	pi.Width = 36
	pi.PromptStyle = lipgloss.NewStyle().Foreground(theme.ColorPrimary)
	pi.TextStyle = lipgloss.NewStyle().Foreground(theme.ColorText)
	pi.PlaceholderStyle = lipgloss.NewStyle().Foreground(theme.ColorTextDim)

	return InputModel{
		keyInput:   ki,
		portInput:  pi,
		focusIndex: 0,
	}
}

// Init returns the initial command (start cursor blink).
func (m InputModel) Init() tea.Cmd {
	return textinput.Blink
}

// Update handles messages for the input view.
func (m InputModel) Update(msg tea.Msg) (InputModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "esc":
			return m, tea.Quit

		case "tab", "shift+tab":
			m.err = ""
			if m.focusIndex == 0 {
				m.focusIndex = 1
				m.keyInput.Blur()
				m.portInput.Focus()
			} else {
				m.focusIndex = 0
				m.portInput.Blur()
				m.keyInput.Focus()
			}
			return m, nil

		case "enter":
			// Validate inputs before submission.
			key := strings.TrimSpace(m.keyInput.Value())
			portStr := strings.TrimSpace(m.portInput.Value())

			if key == "" {
				m.err = "Access Key 不能为空"
				m.focusIndex = 0
				m.portInput.Blur()
				m.keyInput.Focus()
				return m, nil
			}
			if !strings.HasPrefix(key, "ff-") {
				m.err = "Access Key 格式不正确，应以 ff- 开头"
				m.focusIndex = 0
				m.portInput.Blur()
				m.keyInput.Focus()
				return m, nil
			}
			if portStr == "" {
				m.err = "本地端口不能为空"
				m.focusIndex = 1
				m.keyInput.Blur()
				m.portInput.Focus()
				return m, nil
			}
			port, parseErr := strconv.Atoi(portStr)
			if parseErr != nil || port < 1 || port > 65535 {
				m.err = "端口必须为 1-65535 之间的数字"
				m.focusIndex = 1
				m.keyInput.Blur()
				m.portInput.Focus()
				return m, nil
			}

			m.err = ""
			return m, func() tea.Msg {
				return SubmitMsg{Key: key, Port: port}
			}
		}
	}

	// Delegate to the focused text input.
	var cmd tea.Cmd
	if m.focusIndex == 0 {
		m.keyInput, cmd = m.keyInput.Update(msg)
	} else {
		m.portInput, cmd = m.portInput.Update(msg)
	}
	return m, cmd
}

// View renders the input form.
func (m InputModel) View() string {
	var b strings.Builder

	// Brand header.
	b.WriteString(theme.BrandText())
	b.WriteString("\n\n")

	// Key input.
	b.WriteString(theme.InputLabelStyle.Render("Access Key:"))
	b.WriteString("\n")
	if m.focusIndex == 0 {
		b.WriteString(theme.FocusedInputStyle.Render(m.keyInput.View()))
	} else {
		b.WriteString(theme.InputStyle.Render(m.keyInput.View()))
	}
	b.WriteString("\n\n")

	// Port input.
	b.WriteString(theme.InputLabelStyle.Render("本地端口:"))
	b.WriteString("\n")
	if m.focusIndex == 1 {
		b.WriteString(theme.FocusedInputStyle.Render(m.portInput.View()))
	} else {
		b.WriteString(theme.InputStyle.Render(m.portInput.View()))
	}

	// Error message.
	if m.err != "" {
		b.WriteString("\n\n")
		b.WriteString(theme.ErrorStyle.Render("  ✗ " + m.err))
	}

	// Update hint (shown for optional dev updates).
	if m.updateHint != "" && m.err == "" {
		b.WriteString("\n\n")
		b.WriteString(theme.WarningStyle.Render("  ↑ " + m.updateHint))
	}

	// Help bar.
	b.WriteString("\n")
	help := theme.HelpStyle.Render("[Tab] 切换  [Enter] 连接  [Esc] 退出")
	b.WriteString(help)

	// Wrap in the application box.
	content := b.String()
	return theme.AppBoxStyle.Render(content)
}

// SetError sets an external error message on the input view (e.g. from API).
func (m *InputModel) SetError(err string) {
	m.err = err
}

// ClearError removes any displayed error.
func (m *InputModel) ClearError() {
	m.err = ""
}

// SetUpdateHint sets a notification about an available optional update.
func (m *InputModel) SetUpdateHint(hint string) {
	m.updateHint = hint
}

// maskKey returns a partially masked key for display, e.g. "ff-a1b2***".
func maskKey(key string) string {
	if len(key) <= 7 {
		return key
	}
	return key[:7] + "***"
}

// MaskKey is the exported version of maskKey for use by other packages.
func MaskKey(key string) string {
	return maskKey(key)
}

// FmtPort formats a port mapping string, e.g. "25565 → 10001".
func FmtPort(local, remote int) string {
	return fmt.Sprintf("%d → %d", local, remote)
}
