// Package updater implements self-update for the FireFrp client binary.
// It checks GitHub Releases for new versions and replaces the running
// executable in-place, then re-launches.
package updater

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const githubRepo = "lieyanc/FireFrp"

// release represents a GitHub release (subset of fields).
type release struct {
	TagName    string  `json:"tag_name"`
	Prerelease bool    `json:"prerelease"`
	Assets     []asset `json:"assets"`
}

// asset represents a release asset.
type asset struct {
	Name               string `json:"name"`
	BrowserDownloadURL string `json:"browser_download_url"`
}

// UpdateInfo describes an available update.
type UpdateInfo struct {
	Available bool
	Force     bool   // true = release version mismatch, must update
	TargetTag string // the release tag to download from
	Version   string // human-readable version string
}

// IsDevVersion returns true if the version string is a dev build.
func IsDevVersion(v string) bool {
	return strings.HasPrefix(v, "dev-")
}

// assetName returns the expected binary asset name for the current platform.
func assetName() string {
	os := runtime.GOOS
	arch := runtime.GOARCH
	name := fmt.Sprintf("firefrp-%s-%s", os, arch)
	if os == "windows" {
		name += ".exe"
	}
	return name
}

// CheckUpdate compares the server-reported version with the current version
// and determines if an update is needed.
//
// For release versions: force update if mismatch.
// For dev versions: query GitHub for the latest pre-release, non-forced.
func CheckUpdate(serverVersion, currentVersion string) (*UpdateInfo, error) {
	if serverVersion == "" || serverVersion == "unknown" {
		return &UpdateInfo{Available: false}, nil
	}

	if !IsDevVersion(serverVersion) {
		// Release version: force sync
		if serverVersion == currentVersion {
			return &UpdateInfo{Available: false}, nil
		}
		return &UpdateInfo{
			Available: true,
			Force:     true,
			TargetTag: "v" + serverVersion,
			Version:   serverVersion,
		}, nil
	}

	// Dev version: check latest pre-release on GitHub
	latest, err := fetchLatestPrerelease()
	if err != nil {
		return nil, fmt.Errorf("failed to check latest dev release: %w", err)
	}

	if latest == nil {
		return &UpdateInfo{Available: false}, nil
	}

	if latest.TagName == currentVersion {
		return &UpdateInfo{Available: false}, nil
	}

	return &UpdateInfo{
		Available: true,
		Force:     false,
		TargetTag: latest.TagName,
		Version:   latest.TagName,
	}, nil
}

// fetchLatestPrerelease queries the GitHub API for the most recent pre-release.
func fetchLatestPrerelease() (*release, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/releases", githubRepo)
	client := &http.Client{Timeout: 15 * time.Second}

	resp, err := client.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GitHub API returned HTTP %d", resp.StatusCode)
	}

	var releases []release
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, err
	}

	for i := range releases {
		if releases[i].Prerelease {
			return &releases[i], nil
		}
	}

	return nil, nil
}

// DoUpdate downloads the binary for the given release tag and replaces
// the current executable.
func DoUpdate(tag string) error {
	name := assetName()
	downloadURL := fmt.Sprintf(
		"https://github.com/%s/releases/download/%s/%s",
		githubRepo, tag, name,
	)

	// Download to a temp file next to the current executable.
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to determine executable path: %w", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return fmt.Errorf("failed to resolve executable path: %w", err)
	}

	dir := filepath.Dir(exePath)
	tmpFile, err := os.CreateTemp(dir, "firefrp-update-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()

	// Clean up on error.
	defer func() {
		if err != nil {
			os.Remove(tmpPath)
		}
	}()

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Get(downloadURL)
	if err != nil {
		tmpFile.Close()
		return fmt.Errorf("failed to download update: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		tmpFile.Close()
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}

	if _, err = io.Copy(tmpFile, resp.Body); err != nil {
		tmpFile.Close()
		return fmt.Errorf("failed to write update: %w", err)
	}
	tmpFile.Close()

	// Make executable (non-Windows).
	if runtime.GOOS != "windows" {
		if err = os.Chmod(tmpPath, 0o755); err != nil {
			return fmt.Errorf("failed to chmod: %w", err)
		}
	}

	// Replace the current binary.
	if runtime.GOOS == "windows" {
		// Windows can't overwrite a running exe; rename the old one first.
		oldPath := exePath + ".old"
		os.Remove(oldPath) // remove any previous .old file
		if err = os.Rename(exePath, oldPath); err != nil {
			return fmt.Errorf("failed to rename old binary: %w", err)
		}
	}

	if err = os.Rename(tmpPath, exePath); err != nil {
		return fmt.Errorf("failed to replace binary: %w", err)
	}

	return nil
}

// Relaunch re-executes the current binary with the same arguments.
// On Unix, this replaces the current process. On Windows, it starts a
// new process and exits.
func Relaunch() error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return err
	}

	return relaunchPlatform(exePath, os.Args)
}
