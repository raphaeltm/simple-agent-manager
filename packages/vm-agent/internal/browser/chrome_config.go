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
	ViewportWidth    int // Chrome window width (0 = use --start-maximized)
	ViewportHeight   int // Chrome window height (0 = use --start-maximized)
}

// HasViewport reports whether both viewport dimensions are valid positive values.
func (c ChromeCustomization) HasViewport() bool {
	return c.ViewportWidth > 0 && c.ViewportHeight > 0
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

	if c.HasViewport() {
		flags = append(flags, fmt.Sprintf("--window-size=%d,%d", c.ViewportWidth, c.ViewportHeight))
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
// When hasViewport is true, --start-maximized is omitted since --window-size
// in the extra flags controls the window dimensions instead.
func customSupervisordConf(extraFlags []string, hasViewport bool) string {
	flagStr := ""
	if len(extraFlags) > 0 {
		flagStr = " " + strings.Join(extraFlags, " ")
	}

	// When a specific viewport is requested, skip --start-maximized so
	// the --window-size flag in extraFlags controls Chrome's dimensions.
	windowFlag := " --start-maximized"
	if hasViewport {
		windowFlag = ""
	}

	return fmt.Sprintf(`[program:google-chrome]
environment=HOME="/home/neko",USER="neko",DISPLAY=":99.0"
command=/usr/bin/google-chrome --no-sandbox --window-position=0,0%s --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-breakpad --disable-component-extensions-with-background-pages --disable-component-update --disable-default-apps --disable-dev-shm-usage --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --metrics-recording-only --password-store=basic --use-mock-keychain --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222%s
autorestart=true
priority=800
user=neko
stdout_logfile=/var/log/neko/chrome.log
stdout_logfile_maxbytes=100KB
stdout_logfile_backups=0
redirect_stderr=true
`, windowFlag, flagStr)
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

// customXvfbConf generates a supervisord config for Xvfb with the requested
// screen resolution. The default Neko image configures Xvfb via NEKO_SCREEN
// env var, but some image versions ignore it. Writing the supervisord config
// directly and restarting ensures the correct resolution is applied.
func customXvfbConf(width, height int) string {
	return fmt.Sprintf(`[program:xvfb]
command=/usr/bin/Xvfb :99 -screen 0 %dx%dx24
autorestart=true
priority=300
user=neko
stdout_logfile=/var/log/neko/xvfb.log
stdout_logfile_maxbytes=100KB
stdout_logfile_backups=0
redirect_stderr=true
`, width, height)
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

	// 0. Override the Xvfb virtual display resolution if a specific viewport is requested.
	// The NEKO_SCREEN env var should control this at container start, but some Neko
	// image versions ignore it. Writing the Xvfb supervisord config explicitly and
	// restarting ensures the virtual display matches the requested dimensions.
	if c.HasViewport() {
		xvfbConf := customXvfbConf(c.ViewportWidth, c.ViewportHeight)
		xvfbCmd := fmt.Sprintf(
			`cat > /etc/neko/supervisord/xvfb.conf << 'XVFBEOF'
%s
XVFBEOF`, xvfbConf)

		if err := docker.RunSilent(ctx, "exec", containerName, "sh", "-c", xvfbCmd); err != nil {
			slog.Warn("Failed to write Xvfb supervisord config", "container", containerName, "error", err)
		} else {
			slog.Info("Xvfb supervisord config written", "container", containerName,
				"width", c.ViewportWidth, "height", c.ViewportHeight)
		}
	}

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
	supervisordConf := customSupervisordConf(extraFlags, c.HasViewport())

	// Escape the config for shell heredoc
	confCmd := fmt.Sprintf(
		`cat > /etc/neko/supervisord/google-chrome.conf << 'CONFEOF'
%s
CONFEOF`, supervisordConf)

	if err := docker.RunSilent(ctx, "exec", containerName, "sh", "-c", confCmd); err != nil {
		return fmt.Errorf("failed to write Chrome supervisord config: %w", err)
	}
	slog.Info("Chrome supervisord config written", "container", containerName, "flags", len(extraFlags))

	// 3. Restart Xvfb and Chrome via supervisorctl.
	// Xvfb must restart first to apply the new screen resolution, then Chrome
	// restarts to pick up the new config + policies.
	// NOTE: socat forwarders are pre-established by the initial syncForwarders()
	// call in Manager.Start() before this function runs, so the startURL port
	// is already forwarded and properly tracked in state.
	if err := docker.RunSilent(ctx, "exec", containerName, "supervisorctl", "reread"); err != nil {
		slog.Warn("supervisorctl reread failed", "container", containerName, "error", err)
	}
	if c.HasViewport() {
		// Restart Xvfb to apply the new display resolution. This also kills Chrome
		// since Chrome depends on the X display. Supervisord auto-restarts Chrome.
		if err := docker.RunSilent(ctx, "exec", containerName, "supervisorctl", "restart", "xvfb"); err != nil {
			slog.Warn("Failed to restart Xvfb in Neko container", "container", containerName, "error", err)
		} else {
			slog.Info("Xvfb restarted with custom resolution", "container", containerName,
				"width", c.ViewportWidth, "height", c.ViewportHeight)
		}
	}
	if err := docker.RunSilent(ctx, "exec", containerName, "supervisorctl", "restart", "google-chrome"); err != nil {
		slog.Warn("Failed to restart Chrome in Neko container", "container", containerName, "error", err)
		// Non-fatal — Chrome may still work with old config
	} else {
		slog.Info("Chrome restarted with custom config", "container", containerName)
	}

	return nil
}
