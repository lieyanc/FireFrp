package views

import (
	"fmt"
	"strings"
	"sync"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/AerNos/firefrp-client/internal/api"
	"github.com/AerNos/firefrp-client/internal/tui/theme"
)

// ServerSelectedMsg is emitted when the user selects a server.
type ServerSelectedMsg struct {
	APIUrl        string
	ServerName    string // Display name (from discovery or manual URL).
	ClientVersion string // Expected client version reported by this server.
}

// serverEntry holds a discovered server with its status.
type serverEntry struct {
	apiUrl string
	info   *api.ServerInfo
	err    error // non-nil if the server is unreachable
}

// serversLoadedMsg is sent when the server list has been fetched and probed.
type serversLoadedMsg struct {
	servers []serverEntry
	err     error // non-nil if the list itself failed to load
}

// ServerSelectModel is the Bubble Tea model for the server selection view.
type ServerSelectModel struct {
	servers       []serverEntry
	cursor        int
	loading       bool
	loadErr       string
	spinner       spinner.Model
	manualInput   textinput.Model
	manualMode    bool // true when cursor is on the manual input row
	width         int
	height        int
	serverListURL string
}

// NewServerSelectModel creates a ServerSelectModel that will fetch servers
// from the given URL.
func NewServerSelectModel(serverListURL string) ServerSelectModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = theme.SpinnerStyle

	mi := textinput.New()
	mi.Placeholder = "http://example.com:9001"
	mi.CharLimit = 128
	mi.Width = 36
	mi.PromptStyle = lipgloss.NewStyle().Foreground(theme.ColorPrimary)
	mi.TextStyle = lipgloss.NewStyle().Foreground(theme.ColorText)
	mi.PlaceholderStyle = lipgloss.NewStyle().Foreground(theme.ColorTextDim)

	return ServerSelectModel{
		loading:       true,
		spinner:       s,
		manualInput:   mi,
		serverListURL: serverListURL,
	}
}

// Init returns the initial commands: start spinner and fetch server list.
func (m ServerSelectModel) Init() tea.Cmd {
	return tea.Batch(m.spinner.Tick, m.fetchServers())
}

// Update handles messages for the server selection view.
func (m ServerSelectModel) Update(msg tea.Msg) (ServerSelectModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case spinner.TickMsg:
		if m.loading {
			var cmd tea.Cmd
			m.spinner, cmd = m.spinner.Update(msg)
			return m, cmd
		}
		return m, nil

	case serversLoadedMsg:
		m.loading = false
		if msg.err != nil {
			m.loadErr = msg.err.Error()
			// Even on error, allow manual input
			m.manualMode = true
			m.manualInput.Focus()
			return m, textinput.Blink
		}
		m.servers = msg.servers
		return m, nil

	case tea.KeyMsg:
		if msg.String() == "ctrl+c" || msg.String() == "esc" {
			if m.manualMode && len(m.servers) > 0 {
				// Exit manual mode, go back to list
				m.manualMode = false
				m.manualInput.Blur()
				return m, nil
			}
			return m, tea.Quit
		}

		if m.loading {
			return m, nil
		}

		if m.manualMode {
			return m.handleManualInput(msg)
		}

		return m.handleListNavigation(msg)
	}

	// Forward to sub-components
	if m.manualMode {
		var cmd tea.Cmd
		m.manualInput, cmd = m.manualInput.Update(msg)
		return m, cmd
	}

	return m, nil
}

func (m ServerSelectModel) handleListNavigation(msg tea.KeyMsg) (ServerSelectModel, tea.Cmd) {
	totalItems := len(m.servers) + 1 // +1 for manual input option

	switch msg.String() {
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < totalItems-1 {
			m.cursor++
		}
	case "enter":
		if m.cursor < len(m.servers) {
			entry := m.servers[m.cursor]
			if entry.err != nil {
				// Can't select an offline server
				return m, nil
			}
			name := entry.info.Name
			apiUrl := entry.apiUrl
			clientVersion := entry.info.ClientVersion
			return m, func() tea.Msg {
				return ServerSelectedMsg{APIUrl: apiUrl, ServerName: name, ClientVersion: clientVersion}
			}
		}
		// Manual input option selected
		m.manualMode = true
		m.manualInput.Focus()
		return m, textinput.Blink
	}

	return m, nil
}

func (m ServerSelectModel) handleManualInput(msg tea.KeyMsg) (ServerSelectModel, tea.Cmd) {
	switch msg.String() {
	case "enter":
		addr := strings.TrimSpace(m.manualInput.Value())
		if addr == "" {
			return m, nil
		}
		// Ensure it has a scheme
		if !strings.HasPrefix(addr, "http://") && !strings.HasPrefix(addr, "https://") {
			addr = "http://" + addr
		}
		return m, func() tea.Msg {
			return ServerSelectedMsg{APIUrl: addr, ServerName: addr}
		}
	}

	var cmd tea.Cmd
	m.manualInput, cmd = m.manualInput.Update(msg)
	return m, cmd
}

// View renders the server selection view.
func (m ServerSelectModel) View() string {
	var b strings.Builder

	b.WriteString(theme.BrandText())
	b.WriteString("\n\n")

	b.WriteString(theme.InputLabelStyle.Render("选择服务器:"))
	b.WriteString("\n")

	if m.loading {
		b.WriteString("\n")
		b.WriteString(m.spinner.View())
		b.WriteString(" 正在获取服务器列表...")
		b.WriteString("\n")
	} else if m.loadErr != "" && len(m.servers) == 0 {
		b.WriteString("\n")
		b.WriteString(theme.ErrorStyle.Render("  ✗ 获取服务器列表失败: " + m.loadErr))
		b.WriteString("\n\n")
		b.WriteString(theme.InputLabelStyle.Render("手动输入服务器地址:"))
		b.WriteString("\n")
		b.WriteString(theme.FocusedInputStyle.Render(m.manualInput.View()))
	} else if m.manualMode {
		b.WriteString("\n")
		b.WriteString(theme.InputLabelStyle.Render("输入服务器 API 地址:"))
		b.WriteString("\n")
		b.WriteString(theme.FocusedInputStyle.Render(m.manualInput.View()))
	} else {
		b.WriteString("\n")
		for i, entry := range m.servers {
			selected := i == m.cursor

			var line string
			if entry.err != nil {
				// Offline server
				dot := lipgloss.NewStyle().Foreground(theme.ColorError).Bold(true).Render("●")
				name := lipgloss.NewStyle().Foreground(theme.ColorTextDim).Render(entry.apiUrl + " (离线)")
				line = fmt.Sprintf("  %s %s", dot, name)
			} else {
				dot := lipgloss.NewStyle().Foreground(theme.ColorSuccess).Bold(true).Render("●")
				name := entry.info.Name
				desc := lipgloss.NewStyle().Foreground(theme.ColorTextDim).Render(
					fmt.Sprintf(" (%s) %s", entry.info.PublicAddr, entry.info.Description),
				)
				line = fmt.Sprintf("  %s %s%s", dot, name, desc)
			}

			if selected {
				line = lipgloss.NewStyle().Foreground(theme.ColorPrimary).Bold(true).Render("▸") + line[1:]
			}

			b.WriteString(line)
			b.WriteString("\n")
		}

		// Manual input option
		manualLine := "  ✎ 手动输入地址..."
		if m.cursor == len(m.servers) {
			manualLine = lipgloss.NewStyle().Foreground(theme.ColorPrimary).Bold(true).Render("▸") +
				" ✎ 手动输入地址..."
		}
		b.WriteString(manualLine)
	}

	// Help bar
	b.WriteString("\n")
	if m.manualMode {
		help := theme.HelpStyle.Render("[Enter] 确认  [Esc] 返回")
		b.WriteString(help)
	} else if !m.loading {
		help := theme.HelpStyle.Render("[↑/↓] 选择  [Enter] 确认  [Esc] 退出")
		b.WriteString(help)
	}

	content := b.String()
	return theme.AppBoxStyle.Render(content)
}

// fetchServers returns a tea.Cmd that fetches the server list and probes each server.
func (m *ServerSelectModel) fetchServers() tea.Cmd {
	url := m.serverListURL
	return func() tea.Msg {
		entries, err := api.FetchServerList(url)
		if err != nil {
			return serversLoadedMsg{err: err}
		}

		if len(entries) == 0 {
			return serversLoadedMsg{err: fmt.Errorf("服务器列表为空")}
		}

		// Probe each server concurrently
		results := make([]serverEntry, len(entries))
		var wg sync.WaitGroup

		for i, entry := range entries {
			wg.Add(1)
			go func(idx int, apiUrl string) {
				defer wg.Done()
				client := api.NewAPIClient(apiUrl)
				info, err := client.FetchServerInfo()
				results[idx] = serverEntry{
					apiUrl: apiUrl,
					info:   info,
					err:    err,
				}
				if info != nil {
					results[idx].info.APIUrl = apiUrl
				}
			}(i, entry.APIUrl)
		}

		wg.Wait()
		return serversLoadedMsg{servers: results}
	}
}
