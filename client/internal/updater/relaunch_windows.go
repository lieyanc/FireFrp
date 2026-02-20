//go:build windows

package updater

import (
	"os"
	"os/exec"
)

func relaunchPlatform(exePath string, args []string) error {
	cmd := exec.Command(exePath, args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Start()
	os.Exit(0)
	return nil // unreachable
}
