package deploy

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var ingressRoutes = []RouteTarget{
	{Hostname: "r1-web-80-env1.apps.box.example.test", Service: "web", ContainerPort: 80, HostPort: 35000},
	{Hostname: "r2-api-3000-env1.apps.box.example.test", Service: "api", ContainerPort: 3000, HostPort: 35001},
}

// Tunnel app ingress: Caddy must do no ACME and listen on loopback only, on the ingress port.
func TestGenerateRootCaddyfile_LoopbackIngressDisablesACMEAndBindsLoopback(t *testing.T) {
	root := GenerateRootCaddyfile(CaddyfileOptions{
		ACMEEmail:        "ops@example.test",
		ACMECA:           "https://acme.example.test/directory",
		LoopbackHTTPPort: 8446,
	})
	for _, want := range []string{"\tauto_https off\n", "\tdefault_bind 127.0.0.1\n", "\thttp_port 8446\n", "import sites/*", "\nhttp:// {\n\trespond 404\n}\n"} {
		if !strings.Contains(root, want) {
			t.Fatalf("root Caddyfile missing %q:\n%s", want, root)
		}
	}
	for _, unwanted := range []string{"email", "acme_ca"} {
		if strings.Contains(root, unwanted) {
			t.Fatalf("loopback root Caddyfile must not configure ACME (%q):\n%s", unwanted, root)
		}
	}
}

// Control: public ingress (every hosted node) keeps its ACME options and automatic HTTPS.
func TestGenerateRootCaddyfile_PublicIngressUnchanged(t *testing.T) {
	root := GenerateRootCaddyfile(CaddyfileOptions{ACMEEmail: "ops@example.test"})
	if root != "# Managed by SAM deployment agent.\n{\n\temail ops@example.test\n}\n\nimport sites/*\n" {
		t.Fatalf("public root Caddyfile changed:\n%q", root)
	}
}

func TestGenerateCaddySnippet_LoopbackSitesArePlainHTTPAndParseBack(t *testing.T) {
	snippet, err := GenerateCaddySnippet(ingressRoutes, true)
	if err != nil {
		t.Fatalf("GenerateCaddySnippet: %v", err)
	}
	if !strings.Contains(snippet, "\nhttp://r1-web-80-env1.apps.box.example.test {\n\tencode zstd gzip\n\treverse_proxy 127.0.0.1:35000\n}") {
		t.Fatalf("loopback snippet:\n%s", snippet)
	}
	public, err := GenerateCaddySnippet(ingressRoutes, false)
	if err != nil {
		t.Fatalf("GenerateCaddySnippet: %v", err)
	}
	if strings.Contains(public, "http://") {
		t.Fatalf("public snippet must keep bare hostnames (automatic HTTPS):\n%s", public)
	}
	want := []string{"r1-web-80-env1.apps.box.example.test", "r2-api-3000-env1.apps.box.example.test"}
	for _, s := range []string{snippet, public} {
		got := SnippetHostnames(s)
		if strings.Join(got, ",") != strings.Join(want, ",") {
			t.Fatalf("SnippetHostnames = %v, want %v", got, want)
		}
	}
}

func TestActiveSitesServeHostname_ReadsTheActiveSnippets(t *testing.T) {
	dir := t.TempDir()
	engine := &Engine{cfg: EngineConfig{EnvironmentID: "env-1", CaddyfilePath: filepath.Join(dir, "Caddyfile"), AppIngressLoopbackPort: 8446}}

	// No snippet yet (or after teardown): nothing is served.
	if served, err := ActiveSitesServeHostname(engine.cfg.CaddyfilePath, ingressRoutes[0].Hostname); err != nil || served {
		t.Fatalf("before apply: served=%v err=%v", served, err)
	}
	snippet, err := GenerateCaddySnippet(ingressRoutes[:1], true)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "sites"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(engine.activeSnippetPath(), []byte(snippet), 0o644); err != nil {
		t.Fatal(err)
	}
	if served, err := ActiveSitesServeHostname(engine.cfg.CaddyfilePath, "R1-WEB-80-ENV1.apps.box.example.test"); err != nil || !served {
		t.Fatalf("applied route: served=%v err=%v", served, err)
	}
	// A route of the same environment that is not applied, and a suffix trick.
	for _, host := range []string{ingressRoutes[1].Hostname, "apps.box.example.test", "x" + ingressRoutes[0].Hostname} {
		if served, err := ActiveSitesServeHostname(engine.cfg.CaddyfilePath, host); err != nil || served {
			t.Fatalf("%s: served=%v err=%v", host, served, err)
		}
	}
}

// Through the engine's real writers: every root Caddyfile write keeps the loopback options in
// tunnel mode (apply/route reload and teardown), and none of them in public mode.
func TestEngineRootCaddyfileWritesFollowTheIngressMode(t *testing.T) {
	for _, tc := range []struct {
		name     string
		port     int
		loopback bool
	}{{"tunnel ingress", 8446, true}, {"public ingress", 0, false}} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			disk, err := NewDiskState(filepath.Join(dir, "state"))
			if err != nil {
				t.Fatal(err)
			}
			snippet, err := GenerateCaddySnippet(ingressRoutes, tc.loopback)
			if err != nil {
				t.Fatal(err)
			}
			if err := disk.WriteRelease(&ReleaseState{Seq: 1, EnvironmentID: "env", NodeID: "node", Status: StatusApplying}, "compose", snippet); err != nil {
				t.Fatal(err)
			}
			engine := NewEngine(disk, nil, EngineConfig{
				EnvironmentID: "env", CaddyfilePath: filepath.Join(dir, "active", "Caddyfile"),
				CaddyReloadCmd: "true", ACMEEmail: "ops@example.test", AppIngressLoopbackPort: tc.port,
			})
			check := func(step string) {
				root, err := os.ReadFile(engine.cfg.CaddyfilePath)
				if err != nil {
					t.Fatalf("%s: %v", step, err)
				}
				hasLoopback := strings.Contains(string(root), "default_bind 127.0.0.1") && strings.Contains(string(root), "auto_https off")
				hasACME := strings.Contains(string(root), "email ops@example.test")
				if hasLoopback != tc.loopback || hasACME == tc.loopback {
					t.Fatalf("%s root Caddyfile:\n%s", step, root)
				}
			}
			if err := engine.reloadCaddy(t.Context(), disk.CaddyfilePath(1)); err != nil {
				t.Fatalf("reloadCaddy: %v", err)
			}
			check("reload")
			if served, _ := ActiveSitesServeHostname(engine.cfg.CaddyfilePath, ingressRoutes[0].Hostname); !served {
				t.Fatalf("applied route not served")
			}
			if err := engine.clearActiveCaddySnippet(t.Context()); err != nil {
				t.Fatalf("clearActiveCaddySnippet: %v", err)
			}
			check("clear")
			if served, _ := ActiveSitesServeHostname(engine.cfg.CaddyfilePath, ingressRoutes[0].Hostname); served {
				t.Fatalf("cleared route still served")
			}
		})
	}
}
