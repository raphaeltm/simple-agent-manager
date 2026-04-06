package browser

import (
	"strings"
	"testing"
)

func TestSanitizeStartURL_ValidLocalhost(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"http://localhost:3000", "http://localhost:3000"},
		{"http://localhost:8080/path", "http://localhost:8080/path"},
		{"https://localhost:443", "https://localhost:443"},
		{"http://127.0.0.1:5000", "http://127.0.0.1:5000"},
		{"http://[::1]:3000", "http://[::1]:3000"},
	}
	for _, tt := range tests {
		got := sanitizeStartURL(tt.input)
		if got != tt.want {
			t.Errorf("sanitizeStartURL(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestSanitizeStartURL_Rejected(t *testing.T) {
	tests := []string{
		"",
		"http://evil.com:3000",
		"ftp://localhost:21",
		"javascript:alert(1)",
		"data:text/html,<h1>hi</h1>",
		"http://192.168.1.1:3000",
		"http://example.com",
		"not-a-url",
	}
	for _, input := range tests {
		got := sanitizeStartURL(input)
		if got != "" {
			t.Errorf("sanitizeStartURL(%q) = %q, want empty string", input, got)
		}
	}
}

func TestSanitizeStartURL_StripsNewlines(t *testing.T) {
	// Percent-encoded newlines must not survive into the supervisord heredoc
	got := sanitizeStartURL("http://localhost:3000/path%0ACONFEOF")
	if strings.Contains(got, "\n") {
		t.Errorf("sanitizeStartURL must strip newlines, got %q", got)
	}
	if strings.Contains(got, "CONFEOF") && strings.Contains(got, "\n") {
		t.Error("heredoc terminator injection must be prevented")
	}
	got2 := sanitizeStartURL("http://localhost:3000/path%0D%0Ainjection")
	if strings.Contains(got2, "\r") || strings.Contains(got2, "\n") {
		t.Errorf("sanitizeStartURL must strip CR/LF, got %q", got2)
	}
}

func TestSanitizeStartURL_StripsFragment(t *testing.T) {
	got := sanitizeStartURL("http://localhost:3000/page#section")
	if strings.Contains(got, "#") {
		t.Errorf("sanitizeStartURL should strip fragment, got %q", got)
	}
	if got != "http://localhost:3000/page" {
		t.Errorf("sanitizeStartURL(%q) = %q, want %q", "http://localhost:3000/page#section", got, "http://localhost:3000/page")
	}
}

func TestBuildChromeFlags_TouchDevice(t *testing.T) {
	flags := buildChromeFlags(ChromeCustomization{IsTouchDevice: true})
	hasTouch := false
	hasDragDrop := false
	for _, f := range flags {
		if f == "--touch-events=enabled" {
			hasTouch = true
		}
		if f == "--enable-touch-drag-drop" {
			hasDragDrop = true
		}
	}
	if !hasTouch {
		t.Error("expected --touch-events=enabled flag for touch device")
	}
	if !hasDragDrop {
		t.Error("expected --enable-touch-drag-drop flag for touch device")
	}
}

func TestBuildChromeFlags_NonTouchDevice(t *testing.T) {
	flags := buildChromeFlags(ChromeCustomization{IsTouchDevice: false})
	for _, f := range flags {
		if strings.Contains(f, "touch") {
			t.Errorf("non-touch device should not have touch flags, got %q", f)
		}
	}
}

func TestBuildChromeFlags_DPR_NoViewport(t *testing.T) {
	// DPR is only applied when no custom viewport is set
	flags := buildChromeFlags(ChromeCustomization{DevicePixelRatio: 3})
	found := false
	for _, f := range flags {
		if f == "--force-device-scale-factor=3" {
			found = true
		}
	}
	if !found {
		t.Error("expected --force-device-scale-factor=3 when no viewport set")
	}
}

func TestBuildChromeFlags_DPR_WithViewport(t *testing.T) {
	// DPR should NOT be applied when viewport is set (display controlled by xrandr)
	flags := buildChromeFlags(ChromeCustomization{
		DevicePixelRatio: 2,
		ViewportWidth:    375,
		ViewportHeight:   667,
	})
	for _, f := range flags {
		if strings.Contains(f, "force-device-scale-factor") {
			t.Errorf("should not have DPR flag when viewport is set, got %q", f)
		}
	}
}

func TestBuildChromeFlags_UserAgent(t *testing.T) {
	flags := buildChromeFlags(ChromeCustomization{UserAgent: "Mozilla/5.0 Test"})
	found := false
	for _, f := range flags {
		if strings.Contains(f, "--user-agent=") && strings.Contains(f, "Mozilla/5.0 Test") {
			found = true
		}
	}
	if !found {
		t.Error("expected --user-agent flag containing the UA string")
	}
}

func TestBuildChromeFlags_NoDisableInfobars(t *testing.T) {
	// --disable-infobars is deprecated since Chrome 77 and must NOT be present
	flags := buildChromeFlags(ChromeCustomization{})
	for _, f := range flags {
		if strings.Contains(f, "disable-infobars") {
			t.Errorf("deprecated --disable-infobars flag must not be present, got %q", f)
		}
	}
}

func TestBuildChromeFlags_StartURL(t *testing.T) {
	flags := buildChromeFlags(ChromeCustomization{StartURL: "http://localhost:3000"})
	last := flags[len(flags)-1]
	if last != "http://localhost:3000" {
		t.Errorf("expected startURL as last flag, got %q", last)
	}
}

func TestChromePolicies_ExtensionsDisabled(t *testing.T) {
	policies := chromePolicies("")
	if v, ok := policies["ExtensionsEnabled"]; !ok || v != false {
		t.Error("expected ExtensionsEnabled: false")
	}
	if v, ok := policies["CommandLineFlagSecurityWarningsEnabled"]; !ok || v != false {
		t.Error("expected CommandLineFlagSecurityWarningsEnabled: false")
	}
}

func TestChromePolicies_StartURL(t *testing.T) {
	policies := chromePolicies("http://localhost:3000")
	if v, ok := policies["RestoreOnStartup"]; !ok || v != 4 {
		t.Error("expected RestoreOnStartup: 4 when startURL is set")
	}
	urls, ok := policies["RestoreOnStartupURLs"].([]string)
	if !ok || len(urls) != 1 || urls[0] != "http://localhost:3000" {
		t.Errorf("expected RestoreOnStartupURLs: [http://localhost:3000], got %v", policies["RestoreOnStartupURLs"])
	}
}

func TestChromePolicies_NoStartURL(t *testing.T) {
	policies := chromePolicies("")
	if _, ok := policies["RestoreOnStartup"]; ok {
		t.Error("RestoreOnStartup should not be set when startURL is empty")
	}
}

func TestBuildChromeFlags_NoWindowSize(t *testing.T) {
	// Viewport control is now handled by xrandr display resize, not --window-size.
	// Chrome always uses --start-maximized to fill the display.
	flags := buildChromeFlags(ChromeCustomization{ViewportWidth: 375, ViewportHeight: 812})
	for _, f := range flags {
		if strings.Contains(f, "--window-size") {
			t.Errorf("should not have --window-size (viewport controlled by xrandr), got %q", f)
		}
	}
}

func TestBuildChromeFlags_NoViewport(t *testing.T) {
	flags := buildChromeFlags(ChromeCustomization{})
	for _, f := range flags {
		if strings.Contains(f, "--window-size") {
			t.Errorf("should not have --window-size when viewport is zero, got %q", f)
		}
	}
}

func TestCustomSupervisordConf_ContainsCommand(t *testing.T) {
	conf := customSupervisordConf([]string{"--no-first-run"})
	if !strings.Contains(conf, "[program:google-chrome]") {
		t.Error("expected supervisord program header")
	}
	if !strings.Contains(conf, "--no-first-run") {
		t.Error("expected --no-first-run in command line")
	}
	if !strings.Contains(conf, "user=neko") {
		t.Error("expected user=neko in config")
	}
	// Must include openbox section to avoid supervisorctl update removing the window manager
	if !strings.Contains(conf, "[program:openbox]") {
		t.Error("expected openbox section in supervisord config")
	}
}

func TestCustomSupervisordConf_NoExtraFlags(t *testing.T) {
	conf := customSupervisordConf(nil)
	if !strings.Contains(conf, "command=/usr/bin/google-chrome") {
		t.Error("expected base chrome command")
	}
	// Should not have double space after last base flag when no extra flags
	if strings.Contains(conf, "--use-mock-keychain  ") {
		t.Error("should not have double space after last base flag when no extra flags")
	}
}

func TestCustomSupervisordConf_AlwaysHasStartMaximized(t *testing.T) {
	// Chrome always uses --start-maximized; viewport controlled by xrandr display resize
	conf := customSupervisordConf(nil)
	if !strings.Contains(conf, "--start-maximized") {
		t.Error("expected --start-maximized (always present, viewport via xrandr)")
	}
}

func TestComputeModeline_375x667(t *testing.T) {
	name, params := computeModeline(375, 667, 30)
	if name != "375x667_30" {
		t.Errorf("expected mode name 375x667_30, got %q", name)
	}
	// Params should contain pixel clock, dimensions, and sync flags
	if !strings.Contains(params, "375") || !strings.Contains(params, "667") {
		t.Errorf("modeline params should contain dimensions, got %q", params)
	}
	if !strings.Contains(params, "-HSync +Vsync") {
		t.Errorf("modeline params should contain sync flags, got %q", params)
	}
}

func TestComputeModeline_StandardResolution(t *testing.T) {
	name, params := computeModeline(1920, 1080, 60)
	if name != "1920x1080_60" {
		t.Errorf("expected mode name 1920x1080_60, got %q", name)
	}
	if !strings.Contains(params, "1920") || !strings.Contains(params, "1080") {
		t.Errorf("modeline params should contain dimensions, got %q", params)
	}
}

func TestHasViewport(t *testing.T) {
	tests := []struct {
		c    ChromeCustomization
		want bool
	}{
		{ChromeCustomization{ViewportWidth: 375, ViewportHeight: 667}, true},
		{ChromeCustomization{ViewportWidth: 0, ViewportHeight: 667}, false},
		{ChromeCustomization{ViewportWidth: 375, ViewportHeight: 0}, false},
		{ChromeCustomization{}, false},
	}
	for _, tt := range tests {
		got := tt.c.HasViewport()
		if got != tt.want {
			t.Errorf("HasViewport(%+v) = %v, want %v", tt.c, got, tt.want)
		}
	}
}
