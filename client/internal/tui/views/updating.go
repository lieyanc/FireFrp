package views

import (
	"strings"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"

	"github.com/AerNos/firefrp-client/internal/tui/theme"
)

// UpdateDoneMsg is emitted when the update has been applied successfully.
type UpdateDoneMsg struct{}

// UpdateErrorMsg is emitted when the update fails.
type UpdateErrorMsg struct {
	Err error
}

// UpdatingModel is the Bubble Tea model for the "updating" spinner view.
type UpdatingModel struct {
	spinner spinner.Model
	version string
	done    bool
	errMsg  string
	width   int
	height  int
}

// NewUpdatingModel creates an UpdatingModel for the given target version.
func NewUpdatingModel(version string) UpdatingModel {
	s := spinner.New()
	s.Spinner = spinner.Dot
	s.Style = theme.SpinnerStyle

	return UpdatingModel{
		spinner: s,
		version: version,
	}
}

// Init starts the spinner animation.
func (m UpdatingModel) Init() tea.Cmd {
	return m.spinner.Tick
}

// Update handles messages for the updating view.
func (m UpdatingModel) Update(msg tea.Msg) (UpdatingModel, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case UpdateDoneMsg:
		m.done = true
		return m, nil

	case UpdateErrorMsg:
		m.errMsg = msg.Err.Error()
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd
	}

	return m, nil
}

// View renders the updating view.
func (m UpdatingModel) View() string {
	var b strings.Builder

	b.WriteString(theme.BrandText())
	b.WriteString("\n\n")

	if m.errMsg != "" {
		b.WriteString("  " + theme.ErrorStyle.Render("✗ 更新失败: "+m.errMsg))
	} else if m.done {
		b.WriteString("  " + theme.SuccessStyle.Render("✓ 更新完成，正在重启..."))
	} else {
		b.WriteString("  " + m.spinner.View() + " 正在更新到 " + m.version + " ...")
	}

	b.WriteString("\n")
	content := b.String()
	return theme.AppBoxStyle.Render(content)
}
