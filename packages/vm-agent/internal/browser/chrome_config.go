package browser

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
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

	// NOTE: --force-device-scale-factor is only applied when NO custom viewport
	// is set. When a viewport is specified, the Xorg display is resized via xrandr
	// and Chrome maximizes to fill it. Applying DPR in that case would make Chrome
	// require DPR × width physical pixels, overflowing the display.
	if c.DevicePixelRatio > 1 && !c.HasViewport() {
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
// Chrome always uses --start-maximized to fill the Xorg display; viewport
// control is handled by resizing the virtual display via xrandr.
//
// The config also includes the [program:openbox] section because Neko's default
// google-chrome.conf bundles both programs. Omitting openbox causes supervisorctl
// update to remove the window manager, breaking Chrome's maximized layout.
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

[program:openbox]
environment=HOME="/home/neko",USER="neko",DISPLAY=":99.0"
command=/usr/bin/openbox --config-file /etc/neko/openbox.xml
autorestart=true
priority=300
user=neko
stdout_logfile=/var/log/neko/openbox.log
stdout_logfile_maxbytes=100MB
stdout_logfile_backups=10
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

// computeModeline generates X11 modeline parameters for a given resolution and
// refresh rate using the GTF (Generalized Timing Formula) algorithm. Returns
// the mode name and the parameter string for xrandr --newmode.
func computeModeline(width, height, refresh int) (string, string) {
	// GTF constants
	const (
		marginPct  = 1.8   // % of active vertical image
		cellGranPx = 8.0   // character cell granularity
		minVPorchL = 1.0   // minimum vertical porch (lines)
		vSyncLines = 3.0   // vertical sync width (lines)
		hSyncPct   = 8.0   // nominal hsync width as % of line period
		minVSyncBP = 550.0 // min time of vsync+back porch (microsec)
		m          = 600.0 // blanking formula gradient
		c          = 40.0  // blanking formula offset
		k          = 128.0 // blanking formula scaling factor
		j          = 20.0  // blanking formula scaling factor weight
	)

	w := float64(width)
	h := float64(height)
	freq := float64(refresh)

	// Estimated horizontal period (microseconds)
	hPeriodEst := ((1.0/freq)-(minVSyncBP/1000000.0)) / (h + minVPorchL) * 1000000.0

	// Vertical sync + back porch (lines)
	vSyncBP := math.Round(minVSyncBP / hPeriodEst)
	if vSyncBP < vSyncLines+minVPorchL {
		vSyncBP = vSyncLines + minVPorchL
	}

	// Total vertical lines
	vTotal := h + vSyncBP + minVPorchL

	// Ideal blanking duty cycle (%)
	cPrime := ((c - j) * k / 256.0) + j
	mPrime := k / 256.0 * m
	idealDutyCycle := cPrime - (mPrime * hPeriodEst / 1000.0)

	// Horizontal blanking pixels
	var hBlank float64
	if idealDutyCycle < 20 {
		hBlank = math.Floor(w*20.0/(100.0-20.0)/(2.0*cellGranPx)+0.5) * 2.0 * cellGranPx
	} else {
		hBlank = math.Floor(w*idealDutyCycle/(100.0-idealDutyCycle)/(2.0*cellGranPx)+0.5) * 2.0 * cellGranPx
	}

	// Total horizontal pixels
	hTotal := w + hBlank

	// Horizontal sync width (pixels, rounded to cell granularity)
	hSync := math.Floor(hTotal*hSyncPct/100.0/cellGranPx+0.5) * cellGranPx

	// Horizontal front and back porch
	hFrontPorch := hBlank/2.0 - hSync
	hBackPorch := hBlank - hFrontPorch - hSync

	// Pixel clock (MHz)
	pixelClock := hTotal * vTotal * freq / 1000000.0

	// Vertical front porch and back porch
	vFrontPorch := minVPorchL
	vBackPorch := vSyncBP - vSyncLines

	// Build xrandr modeline values
	name := fmt.Sprintf("%dx%d_%d", width, height, refresh)
	params := fmt.Sprintf("%.2f %d %d %d %d %d %d %d %d -HSync +Vsync",
		pixelClock,
		width,
		int(w+hFrontPorch),
		int(w+hFrontPorch+hSync),
		int(hTotal),
		height,
		int(h+vFrontPorch),
		int(h+vFrontPorch+vSyncLines),
		int(vTotal),
	)

	// Round margin values to avoid fractional pixel issues in older X servers
	_ = marginPct // used in full GTF but not needed for our simplified version
	_ = hBackPorch
	_ = vBackPorch

	return name, params
}

// chromeMinWidth is the minimum window width Chrome enforces on Linux.
// Chrome cannot render narrower than ~500px on desktop Linux — attempting
// to set a display width below this results in the Chrome window extending
// beyond the display boundaries. We clamp to this minimum.
const chromeMinWidth = 500

// setDisplayResolution changes the Xorg virtual display resolution inside the
// Neko container using xrandr. The Neko v3 image uses Xorg with a dummy driver
// (not Xvfb), so we must:
// 1. Install xrandr (x11-xserver-utils) if not present
// 2. Create a custom modeline for the requested resolution
// 3. Add the mode to the DUMMY0 output
// 4. Switch to the new mode
//
// Note: width is clamped to chromeMinWidth (500px) because Chrome on Linux
// cannot render narrower than that.
func setDisplayResolution(ctx context.Context, docker DockerExecutor, containerName string, width, height int) error {
	if width < chromeMinWidth {
		slog.Info("Clamping display width to Chrome minimum",
			"container", containerName,
			"requested", width, "clamped", chromeMinWidth)
		width = chromeMinWidth
	}
	// Install xrandr if not already present
	installCmd := `command -v xrandr >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y --no-install-recommends x11-xserver-utils >/dev/null 2>&1)`
	if err := docker.RunSilent(ctx, "exec", containerName, "sh", "-c", installCmd); err != nil {
		return fmt.Errorf("failed to install xrandr: %w", err)
	}

	// Compute modeline for the requested resolution
	modeName, modeParams := computeModeline(width, height, 30)

	// Build the xrandr commands to create and switch to the custom mode
	xrandrCmd := fmt.Sprintf(
		`export DISPLAY=:99.0; `+
			`xrandr --newmode "%s" %s 2>/dev/null; `+ // ignore error if mode already exists
			`xrandr --addmode DUMMY0 "%s" 2>/dev/null; `+ // ignore error if already added
			`xrandr --output DUMMY0 --mode "%s"`, // switch to the mode
		modeName, modeParams, modeName, modeName)

	if err := docker.RunSilent(ctx, "exec", containerName, "sh", "-c", xrandrCmd); err != nil {
		return fmt.Errorf("failed to set display resolution via xrandr: %w", err)
	}

	slog.Info("Display resolution set via xrandr",
		"container", containerName,
		"width", width, "height", height,
		"modeName", modeName)
	return nil
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

	// 0. Resize the Xorg virtual display if a specific viewport is requested.
	// Neko v3 uses Xorg with a xf86-video-dummy driver (not Xvfb). The
	// NEKO_SCREEN/NEKO_DESKTOP_SCREEN env var often fails for custom
	// resolutions that don't have predefined modelines. Instead, we use
	// xrandr to create a custom modeline and switch to it dynamically.
	if c.HasViewport() {
		if err := setDisplayResolution(ctx, docker, containerName, c.ViewportWidth, c.ViewportHeight); err != nil {
			slog.Warn("Failed to set display resolution — Chrome will use default 1920x1080",
				"container", containerName, "error", err,
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

	// 2. Write custom supervisord config with Chrome flags.
	// Chrome always uses --start-maximized to fill the Xorg display.
	// Viewport control is handled by resizing the display via xrandr above.
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

	// 3. Restart Chrome via supervisorctl so it picks up the new config + policies.
	// The xrandr display resize (step 0) takes effect immediately — no Xorg
	// restart needed. Chrome just needs to restart to pick up the new config
	// and re-maximize to the resized display.
	// NOTE: We use "supervisorctl update" (not reread+restart) because update
	// re-reads the config AND restarts changed programs with the new command line.
	// Plain "restart" does NOT pick up command= changes — it restarts the old command.
	// NOTE: socat forwarders are pre-established by the initial syncForwarders()
	// call in Manager.Start() before this function runs, so the startURL port
	// is already forwarded and properly tracked in state.
	if err := docker.RunSilent(ctx, "exec", containerName, "supervisorctl", "update"); err != nil {
		slog.Warn("Failed to update Chrome in Neko container", "container", containerName, "error", err)
		// Non-fatal — Chrome may still work with old config
	} else {
		slog.Info("Chrome restarted with custom config", "container", containerName)
	}

	return nil
}
