package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
)

// ChromeCustomization holds the parameters for configuring Chrome inside the Neko container.
type ChromeCustomization struct {
	UserAgent        string
	StartURL         string
	IsTouchDevice    bool
	DevicePixelRatio int
}

// chromePolicies returns a Chrome enterprise policy map that:
// - Disables all extensions (including pre-installed SponsorBlock, uBlock)
// - Suppresses Privacy Sandbox, sign-in, sync, and first-run prompts
// - Sets startup URL if provided
func chromePolicies(startURL string) map[string]any {
	policies := map[string]any{
		// Disable all extensions — removes SponsorBlock, uBlock Origin Lite
		"ExtensionInstallBlocklist":  []string{"*"},
		"ExtensionInstallForcelist":  []string{},
		"ExtensionInstallAllowlist":  []string{},
		"ExtensionsEnabled":          false,

		// Suppress Chrome first-run and privacy prompts
		"BrowserSignin":                0,
		"SyncDisabled":                 true,
		"PrivacySandboxPromptEnabled":  false,
		"PrivacySandboxAdMeasurementEnabled": false,
		"PrivacySandboxAdTopicsEnabled":      false,
		"PrivacySandboxSiteEnabledAdsEnabled": false,
		"PromotionalTabsEnabled":       false,
		"DefaultBrowserSettingEnabled":  false,
		"MetricsReportingEnabled":       false,

		// Clean, minimal UI
		"BookmarkBarEnabled":       false,
		"PasswordManagerEnabled":   false,
		"AutofillAddressEnabled":   false,
		"AutofillCreditCardEnabled": false,
		"TranslateEnabled":         false,
		"DefaultNotificationsSetting": 2, // Block
		"DefaultPopupsSetting":        2, // Block
		"ImportBookmarks":          false,
		"ImportHistory":            false,
		"ImportSearchEngine":       false,

		// Suppress "You are using an unsupported command-line flag" warning bar
		"CommandLineFlagSecurityWarningsEnabled": false,
	}

	// Set startup URL via policy
	if startURL != "" {
		policies["RestoreOnStartup"] = 4 // Open a list of URLs
		policies["RestoreOnStartupURLs"] = []string{startURL}
		policies["HomepageLocation"] = startURL
		policies["HomepageIsNewTabPage"] = false
		policies["NewTabPageLocation"] = startURL
	}

	return policies
}

// buildChromeFlags constructs extra Chrome command-line flags for device emulation.
func buildChromeFlags(c ChromeCustomization) []string {
	var flags []string

	if c.UserAgent != "" {
		// User-agent strings contain spaces and parentheses — must be quoted
		// for the supervisord command line. Use single quotes and escape any
		// single quotes in the value itself.
		safeUA := strings.ReplaceAll(c.UserAgent, "'", "'\"'\"'")
		flags = append(flags, fmt.Sprintf("--user-agent='%s'", safeUA))
	}

	if c.IsTouchDevice {
		flags = append(flags, "--touch-events=enabled")
		flags = append(flags, "--enable-touch-drag-drop")
	}

	if c.DevicePixelRatio > 1 {
		flags = append(flags, fmt.Sprintf("--force-device-scale-factor=%d", c.DevicePixelRatio))
	}

	// Suppress various Chrome UI noise.
	// NOTE: --disable-infobars is intentionally omitted — it is deprecated
	// since Chrome 77 and itself triggers the "unsupported command-line flag"
	// info bar. Use the CommandLineFlagSecurityWarningsEnabled policy instead.
	flags = append(flags,
		"--disable-extensions",
		"--no-first-run",
		"--noerrdialogs",
		"--disable-translate",
		"--disable-features=TranslateUI,PrivacySandboxSettings4",
		"--disable-sync",
		"--no-default-browser-check",
		"--hide-scrollbars",
	)

	// Open startup URL as positional argument
	if c.StartURL != "" {
		flags = append(flags, c.StartURL)
	}

	return flags
}

// customSupervisordConf generates a supervisord config for Chrome that includes
// custom flags. The default Neko google-chrome image hardcodes Chrome flags in
// its supervisord config with no env var expansion, so we must override it.
func customSupervisordConf(extraFlags []string) string {
	flagStr := ""
	if len(extraFlags) > 0 {
		flagStr = " " + strings.Join(extraFlags, " ")
	}

	return fmt.Sprintf(`[program:google-chrome]
environment=HOME="/home/neko",USER="neko",DISPLAY=":99.0"
command=/usr/bin/google-chrome --no-sandbox --window-position=0,0 --start-maximized --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-breakpad --disable-component-extensions-with-background-pages --disable-component-update --disable-default-apps --disable-dev-shm-usage --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --metrics-recording-only --password-store=basic --use-mock-keychain --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222%s
autorestart=true
priority=800
user=neko
stdout_logfile=/var/log/neko/chrome.log
stdout_logfile_maxbytes=100KB
stdout_logfile_backups=0
redirect_stderr=true
`, flagStr)
}

// sanitizeStartURL validates and sanitizes the startup URL. Only http/https
// URLs targeting localhost are allowed to prevent injection.
func sanitizeStartURL(rawURL string) string {
	if rawURL == "" {
		return ""
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return ""
	}
	host := parsed.Hostname()
	if host != "localhost" && host != "127.0.0.1" && host != "::1" {
		return ""
	}
	// Strip fragment — '#' in supervisord command= lines starts a comment,
	// which would silently truncate the URL.
	parsed.Fragment = ""
	result := parsed.String()
	// Belt-and-suspenders: strip any newlines that could break heredoc boundaries.
	// Go's url.Parse may preserve percent-encoded newlines (%0A) in some positions.
	result = strings.ReplaceAll(result, "\n", "")
	result = strings.ReplaceAll(result, "\r", "")
	return result
}

// applyChromeCustomization injects Chrome enterprise policies and a custom
// supervisord config into a running Neko container, then restarts Chrome so it
// picks up the changes. This must be called after `docker run` and after the
// initial syncForwarders() in Manager.Start() — socat forwarders are already
// established and tracked in state before Chrome opens the startURL.
func applyChromeCustomization(ctx context.Context, docker DockerExecutor, containerName string, c ChromeCustomization) error {
	// Sanitize the startup URL — only localhost URLs allowed
	safeURL := sanitizeStartURL(c.StartURL)
	if c.StartURL != "" && safeURL == "" {
		slog.Warn("Rejected non-localhost startURL", "container", containerName, "url", c.StartURL)
	}
	c.StartURL = safeURL

	// 1. Write Chrome enterprise policy JSON
	policyMap := chromePolicies(c.StartURL)
	policyJSON, err := json.Marshal(policyMap)
	if err != nil {
		return fmt.Errorf("failed to marshal Chrome policies: %w", err)
	}

	// Create policy directory and write the file
	policyCmd := fmt.Sprintf(
		`mkdir -p /etc/opt/chrome/policies/managed && cat > /etc/opt/chrome/policies/managed/sam-policy.json << 'POLICYEOF'
%s
POLICYEOF`, string(policyJSON))

	if err := docker.RunSilent(ctx, "exec", containerName, "sh", "-c", policyCmd); err != nil {
		slog.Warn("Failed to write Chrome policy file", "container", containerName, "error", err)
		// Non-fatal — continue with flags
	} else {
		slog.Info("Chrome policy file written", "container", containerName)
	}

	// 2. Write custom supervisord config with Chrome flags
	extraFlags := buildChromeFlags(c)
	supervisordConf := customSupervisordConf(extraFlags)

	// Escape the config for shell heredoc
	confCmd := fmt.Sprintf(
		`cat > /etc/neko/supervisord/google-chrome.conf << 'CONFEOF'
%s
CONFEOF`, supervisordConf)

	if err := docker.RunSilent(ctx, "exec", containerName, "sh", "-c", confCmd); err != nil {
		return fmt.Errorf("failed to write Chrome supervisord config: %w", err)
	}
	slog.Info("Chrome supervisord config written", "container", containerName, "flags", len(extraFlags))

	// 3. Restart Chrome via supervisorctl so it picks up the new config + policies
	// NOTE: socat forwarders are pre-established by the initial syncForwarders()
	// call in Manager.Start() before this function runs, so the startURL port
	// is already forwarded and properly tracked in state.
	if err := docker.RunSilent(ctx, "exec", containerName, "supervisorctl", "reread"); err != nil {
		slog.Warn("supervisorctl reread failed", "container", containerName, "error", err)
	}
	if err := docker.RunSilent(ctx, "exec", containerName, "supervisorctl", "restart", "google-chrome"); err != nil {
		slog.Warn("Failed to restart Chrome in Neko container", "container", containerName, "error", err)
		// Non-fatal — Chrome may still work with old config
	} else {
		slog.Info("Chrome restarted with custom config", "container", containerName)
	}

	return nil
}
