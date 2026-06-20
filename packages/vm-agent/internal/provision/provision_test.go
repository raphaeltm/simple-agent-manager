package provision

import (
	"runtime"
	"testing"
)

func TestParseComposeVersion(t *testing.T) {
	cases := []struct {
		in          string
		major       int
		minor       int
		ok          bool
		supports    bool
		description string
	}{
		{"2.40.3", 2, 40, true, true, "modern stable release"},
		{"v2.35.0", 2, 35, true, true, "exact minimum with v prefix"},
		{"2.34.0", 2, 34, true, false, "one minor below minimum"},
		{"v2.20.2", 2, 20, true, false, "old docker-ce base image plugin"},
		{"2.40.3-desktop.1", 2, 40, true, true, "desktop suffix"},
		{"3.0.0", 3, 0, true, true, "future major"},
		{"  2.41.0\n", 2, 41, true, true, "whitespace trimmed"},
		{"garbage", 0, 0, false, false, "unparseable"},
		{"2", 0, 0, false, false, "missing minor"},
		{"", 0, 0, false, false, "empty"},
	}
	for _, c := range cases {
		t.Run(c.description, func(t *testing.T) {
			major, minor, ok := parseComposeVersion(c.in)
			if ok != c.ok {
				t.Fatalf("parseComposeVersion(%q) ok = %v, want %v", c.in, ok, c.ok)
			}
			if !ok {
				return
			}
			if major != c.major || minor != c.minor {
				t.Fatalf("parseComposeVersion(%q) = %d.%d, want %d.%d", c.in, major, minor, c.major, c.minor)
			}
			if got := composeSupportsProvider(major, minor); got != c.supports {
				t.Fatalf("composeSupportsProvider(%d, %d) = %v, want %v", major, minor, got, c.supports)
			}
		})
	}
}

func TestComposeSupportsProviderGate(t *testing.T) {
	// The gate exists specifically to admit Docker Model Runner `provider:`
	// services, which require compose v2.35+. Below that, `docker compose config`
	// rejects the schema with "Additional property provider is not allowed".
	if composeSupportsProvider(2, minComposeMinor-1) {
		t.Fatalf("expected 2.%d to be unsupported", minComposeMinor-1)
	}
	if !composeSupportsProvider(2, minComposeMinor) {
		t.Fatalf("expected 2.%d to be supported", minComposeMinor)
	}
}

func TestTargetComposeVersionDefault(t *testing.T) {
	t.Setenv("SAM_DOCKER_COMPOSE_VERSION", "")
	if got := targetComposeVersion(); got != defaultComposeVersion {
		t.Fatalf("targetComposeVersion() = %q, want default %q", got, defaultComposeVersion)
	}
	// The default must itself satisfy the provider gate, otherwise the upgrade
	// step would install a plugin that still fails validation.
	major, minor, ok := parseComposeVersion(defaultComposeVersion)
	if !ok || !composeSupportsProvider(major, minor) {
		t.Fatalf("defaultComposeVersion %q does not satisfy the provider gate", defaultComposeVersion)
	}
}

func TestTargetComposeVersionOverride(t *testing.T) {
	t.Setenv("SAM_DOCKER_COMPOSE_VERSION", "v2.50.0")
	if got := targetComposeVersion(); got != "v2.50.0" {
		t.Fatalf("targetComposeVersion() = %q, want override v2.50.0", got)
	}
}

func TestComposeArchSupported(t *testing.T) {
	// The provisioner only runs on the architectures we provision (amd64/arm64).
	switch runtime.GOARCH {
	case "amd64":
		if got := composeArch(); got != "x86_64" {
			t.Fatalf("composeArch() = %q, want x86_64", got)
		}
	case "arm64":
		if got := composeArch(); got != "aarch64" {
			t.Fatalf("composeArch() = %q, want aarch64", got)
		}
	}
}
