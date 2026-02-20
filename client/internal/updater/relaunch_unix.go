//go:build !windows

package updater

import (
	"os"
	"syscall"
)

func relaunchPlatform(exePath string, args []string) error {
	return syscall.Exec(exePath, args, os.Environ())
}
