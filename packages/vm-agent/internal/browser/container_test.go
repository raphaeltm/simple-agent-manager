package browser

import (
	"strings"
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
			env := buildNekoEnv(tt.resolution, tt.maxFPS, 8080, "neko", "admin", tt.audio, tt.tcpFallback)

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

			// Always has password, admin password, and bind
			if !contains(env, "NEKO_PASSWORD=neko") {
				t.Error("missing NEKO_PASSWORD")
			}
			if !contains(env, "NEKO_PASSWORD_ADMIN=admin") {
				t.Error("missing NEKO_PASSWORD_ADMIN")
			}
			if !contains(env, "NEKO_BIND=:8080") {
				t.Error("missing NEKO_BIND")
			}
		})
	}
}

func TestBuildDockerRunArgs(t *testing.T) {
	env := []string{"NEKO_SCREEN=1920x1080@30", "NEKO_BIND=:8080"}
	limits := ResourceLimits{
		MemoryLimit: "4g",
		CPULimit:    "2",
		PidsLimit:   512,
	}
	args := buildDockerRunArgs("neko-ws-123", "ghcr.io/m1k1o/neko/google-chrome:latest", "workspace-net", "2g", 8080, env, limits)

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

	// Must use --restart no instead of --restart unless-stopped
	if !containsPair(args, "--restart", "no") {
		t.Error("missing --restart no")
	}
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--restart" && args[i+1] == "unless-stopped" {
			t.Error("should not use --restart unless-stopped")
		}
	}

	// Must include security-opt no-new-privileges
	if !containsPair(args, "--security-opt", "no-new-privileges") {
		t.Error("missing --security-opt no-new-privileges")
	}

	// Must include resource limits
	if !containsPair(args, "--memory", "4g") {
		t.Error("missing --memory 4g")
	}
	if !containsPair(args, "--cpus", "2") {
		t.Error("missing --cpus 2")
	}
	if !containsPair(args, "--pids-limit", "512") {
		t.Error("missing --pids-limit 512")
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

func TestBuildDockerRunArgsNoLimits(t *testing.T) {
	env := []string{"NEKO_BIND=:8080"}
	limits := ResourceLimits{} // empty limits
	args := buildDockerRunArgs("neko-ws-1", "image", "net", "2g", 8080, env, limits)

	for _, a := range args {
		if a == "--memory" || a == "--cpus" || a == "--pids-limit" {
			t.Errorf("should not include resource limit flag %q when limits are empty", a)
		}
	}
}

func TestGenerateRandomPassword(t *testing.T) {
	p1, err := generateRandomPassword(32)
	if err != nil {
		t.Fatalf("generateRandomPassword error: %v", err)
	}
	if len(p1) != 64 { // 32 bytes = 64 hex chars
		t.Errorf("expected 64 hex chars, got %d", len(p1))
	}

	p2, _ := generateRandomPassword(32)
	if p1 == p2 {
		t.Error("two random passwords should not be equal")
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

func containsSubstring(ss []string, sub string) bool {
	for _, x := range ss {
		if strings.Contains(x, sub) {
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
