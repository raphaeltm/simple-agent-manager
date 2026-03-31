package browser

import (
	"testing"
)

func TestBuildNekoEnv(t *testing.T) {
	tests := []struct {
		name        string
		resolution  string
		maxFPS      int
		audio       bool
		tcpFallback bool
		wantLen     int
		wantScreen  string
		wantAudio   bool
		wantICE     bool
	}{
		{
			name:       "default with audio and TCP fallback",
			resolution: "1920x1080", maxFPS: 30,
			audio: true, tcpFallback: true,
			wantLen: 5, wantScreen: "NEKO_SCREEN=1920x1080@30",
			wantAudio: false, wantICE: true,
		},
		{
			name:       "no audio",
			resolution: "1280x720", maxFPS: 24,
			audio: false, tcpFallback: false,
			wantLen: 5, wantScreen: "NEKO_SCREEN=1280x720@24",
			wantAudio: true, wantICE: false,
		},
		{
			name:       "custom resolution no fallback",
			resolution: "375x667", maxFPS: 60,
			audio: true, tcpFallback: false,
			wantLen: 4, wantScreen: "NEKO_SCREEN=375x667@60",
			wantAudio: false, wantICE: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			env := buildNekoEnv(tt.resolution, tt.maxFPS, tt.audio, tt.tcpFallback)

			if len(env) != tt.wantLen {
				t.Errorf("expected %d env vars, got %d: %v", tt.wantLen, len(env), env)
			}

			if env[0] != tt.wantScreen {
				t.Errorf("expected screen=%q, got %q", tt.wantScreen, env[0])
			}

			hasAudioFalse := contains(env, "NEKO_AUDIO=false")
			if hasAudioFalse != tt.wantAudio {
				t.Errorf("NEKO_AUDIO=false present=%v, want=%v", hasAudioFalse, tt.wantAudio)
			}

			hasICE := contains(env, "NEKO_ICELITE=true")
			if hasICE != tt.wantICE {
				t.Errorf("NEKO_ICELITE=true present=%v, want=%v", hasICE, tt.wantICE)
			}

			// Always has password and bind
			if !contains(env, "NEKO_PASSWORD=neko") {
				t.Error("missing NEKO_PASSWORD")
			}
			if !contains(env, "NEKO_BIND=:8080") {
				t.Error("missing NEKO_BIND")
			}
		})
	}
}

func TestBuildDockerRunArgs(t *testing.T) {
	env := []string{"NEKO_SCREEN=1920x1080@30", "NEKO_BIND=:8080"}
	args := buildDockerRunArgs("neko-ws-123", "ghcr.io/m1k1o/neko/google-chrome:latest", "workspace-net", 8080, env)

	// Must start with "run -d"
	if args[0] != "run" || args[1] != "-d" {
		t.Errorf("expected 'run -d', got %q %q", args[0], args[1])
	}

	// Must include container name
	if !containsPair(args, "--name", "neko-ws-123") {
		t.Error("missing --name neko-ws-123")
	}

	// Must include network
	if !containsPair(args, "--network", "workspace-net") {
		t.Error("missing --network workspace-net")
	}

	// Must include shm-size
	if !contains(args, "--shm-size=2g") {
		t.Error("missing --shm-size=2g")
	}

	// Must include env vars
	envCount := 0
	for _, a := range args {
		if a == "-e" {
			envCount++
		}
	}
	if envCount != len(env) {
		t.Errorf("expected %d -e flags, got %d", len(env), envCount)
	}

	// Image must be last arg
	if args[len(args)-1] != "ghcr.io/m1k1o/neko/google-chrome:latest" {
		t.Errorf("expected image as last arg, got %q", args[len(args)-1])
	}
}

func TestBuildViewportChromeFlags(t *testing.T) {
	tests := []struct {
		name     string
		w, h     int
		dpr      int
		touch    bool
		wantLen  int
		wantNil  bool
	}{
		{"zero dimensions returns nil", 0, 0, 1, false, 0, true},
		{"standard desktop", 1920, 1080, 1, false, 1, false},
		{"mobile with HiDPI and touch", 375, 667, 3, true, 4, false},
		{"desktop with HiDPI", 2560, 1440, 2, false, 2, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			flags := buildViewportChromeFlags(tt.w, tt.h, tt.dpr, tt.touch)

			if tt.wantNil && flags != nil {
				t.Errorf("expected nil, got %v", flags)
				return
			}
			if !tt.wantNil && flags == nil {
				t.Fatal("expected non-nil flags")
			}
			if !tt.wantNil && len(flags) != tt.wantLen {
				t.Errorf("expected %d flags, got %d: %v", tt.wantLen, len(flags), flags)
			}
		})
	}
}

func TestTrimOutput(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"abc123\n", "abc123"},
		{"  spaces  ", "spaces"},
		{"\n\nhello\n\n", "hello"},
		{"", ""},
	}

	for _, tt := range tests {
		got := trimOutput([]byte(tt.input))
		if got != tt.want {
			t.Errorf("trimOutput(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestNekoContainerName(t *testing.T) {
	name := nekoContainerName("ws-abc-123")
	if name != "neko-ws-abc-123" {
		t.Errorf("expected neko-ws-abc-123, got %s", name)
	}
}

// helpers

func contains(ss []string, s string) bool {
	for _, x := range ss {
		if x == s {
			return true
		}
	}
	return false
}

func containsPair(ss []string, key, val string) bool {
	for i := 0; i < len(ss)-1; i++ {
		if ss[i] == key && ss[i+1] == val {
			return true
		}
	}
	return false
}
