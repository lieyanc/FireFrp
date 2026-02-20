package theme

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// FireFrp brand color palette (flame theme).
var (
	ColorPrimary   = lipgloss.Color("#FF6B35") // Flame orange
	ColorAccent    = lipgloss.Color("#FF3333") // Flame red
	ColorBg        = lipgloss.Color("#1A1A2E") // Dark background
	ColorText      = lipgloss.Color("#E0E0E0") // Light text
	ColorTextDim   = lipgloss.Color("#888888") // Dimmed text
	ColorSuccess   = lipgloss.Color("#00CC66") // Green
	ColorWarning   = lipgloss.Color("#FFD700") // Yellow
	ColorError     = lipgloss.Color("#FF4444") // Red
	ColorBorder    = lipgloss.Color("#444466") // Muted border
	ColorBorderFoc = lipgloss.Color("#FF6B35") // Focused border (primary)
)

// TitleStyle renders the application title in bold primary color.
var TitleStyle = lipgloss.NewStyle().
	Bold(true).
	Foreground(ColorPrimary).
	MarginBottom(0)

// SubtitleStyle renders the subtitle / tagline.
var SubtitleStyle = lipgloss.NewStyle().
	Foreground(ColorTextDim).
	MarginBottom(1)

// InputLabelStyle renders text labels above input fields.
var InputLabelStyle = lipgloss.NewStyle().
	Foreground(ColorText).
	Bold(true).
	MarginBottom(0)

// InputStyle renders unfocused text input boxes.
var InputStyle = lipgloss.NewStyle().
	BorderStyle(lipgloss.RoundedBorder()).
	BorderForeground(ColorBorder).
	Padding(0, 1).
	Width(40)

// FocusedInputStyle renders text input boxes that have focus.
var FocusedInputStyle = lipgloss.NewStyle().
	BorderStyle(lipgloss.RoundedBorder()).
	BorderForeground(ColorBorderFoc).
	Padding(0, 1).
	Width(40)

// StatusStyle renders the bottom status bar text.
var StatusStyle = lipgloss.NewStyle().
	Foreground(ColorTextDim).
	MarginTop(1)

// ErrorStyle renders error messages.
var ErrorStyle = lipgloss.NewStyle().
	Foreground(ColorError).
	Bold(true)

// SuccessStyle renders success messages.
var SuccessStyle = lipgloss.NewStyle().
	Foreground(ColorSuccess).
	Bold(true)

// WarningStyle renders warning messages.
var WarningStyle = lipgloss.NewStyle().
	Foreground(ColorWarning)

// HelpStyle renders help / hint text at the bottom of views.
var HelpStyle = lipgloss.NewStyle().
	Foreground(ColorTextDim).
	MarginTop(1)

// BoxStyle renders information panels with a rounded border and padding.
var BoxStyle = lipgloss.NewStyle().
	BorderStyle(lipgloss.RoundedBorder()).
	BorderForeground(ColorBorder).
	Padding(1, 2).
	MarginTop(1).
	MarginBottom(1)

// BoxTitleStyle renders the title of an info box.
var BoxTitleStyle = lipgloss.NewStyle().
	Foreground(ColorPrimary).
	Bold(true)

// SpinnerStyle renders the spinner animation.
var SpinnerStyle = lipgloss.NewStyle().
	Foreground(ColorPrimary)

// AppBoxStyle wraps the entire application view with a bordered frame.
var AppBoxStyle = lipgloss.NewStyle().
	BorderStyle(lipgloss.RoundedBorder()).
	BorderForeground(ColorPrimary).
	Padding(1, 3).
	Width(48)

// DotConnected renders the green "connected" indicator dot.
var DotConnected = lipgloss.NewStyle().
	Foreground(ColorSuccess).
	Bold(true).
	Render("●")

// DotReconnecting renders the yellow "reconnecting" indicator dot.
var DotReconnecting = lipgloss.NewStyle().
	Foreground(ColorWarning).
	Bold(true).
	Render("●")

// DotError renders the red "error" indicator dot.
var DotError = lipgloss.NewStyle().
	Foreground(ColorError).
	Bold(true).
	Render("●")

// LabelStyle renders key-value labels inside info boxes.
var LabelStyle = lipgloss.NewStyle().
	Foreground(ColorTextDim).
	Width(10)

// ValueStyle renders key-value values inside info boxes.
var ValueStyle = lipgloss.NewStyle().
	Foreground(ColorText)

// LogBoxStyle renders the log panel with a rounded border.
var LogBoxStyle = lipgloss.NewStyle().
	BorderStyle(lipgloss.RoundedBorder()).
	BorderForeground(ColorBorder).
	Padding(0, 1).
	MarginTop(1)

// LogTimeStyle renders the timestamp portion of a log entry.
var LogTimeStyle = lipgloss.NewStyle().
	Foreground(ColorTextDim)

// LogLevelWarn renders warning-level log indicators.
var LogLevelWarn = lipgloss.NewStyle().
	Foreground(ColorWarning)

// LogLevelError renders error-level log indicators (bold).
var LogLevelError = lipgloss.NewStyle().
	Foreground(ColorError).
	Bold(true)

// clientVersion holds the build version, set via SetVersion().
var clientVersion string

// SetVersion stores the client version for display in BrandText.
func SetVersion(v string) {
	clientVersion = v
}

// formatVersion returns the version string for display.
// Release versions (e.g. "1.0.0") get a "v" prefix.
// Dev versions (e.g. "dev-6-20260220-abc") are returned as-is.
func formatVersion(v string) string {
	if v == "" {
		return ""
	}
	if len(v) > 0 && v[0] >= '0' && v[0] <= '9' {
		return "v" + v
	}
	return v
}

// BrandText returns the styled FireFrp header block (title + version + subtitle).
func BrandText() string {
	parts := []string{"FireFrp Client"}
	if clientVersion != "" {
		parts = append(parts, formatVersion(clientVersion))
	}
	title := TitleStyle.Render(strings.Join(parts, " "))
	subtitle := SubtitleStyle.Render("临时隧道，一键开服")
	return lipgloss.JoinVertical(lipgloss.Center, title, subtitle)
}
