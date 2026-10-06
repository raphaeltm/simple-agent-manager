package config

import (
	"testing"
	"time"
)

func TestCodexRuntimeInstallBounds(t *testing.T) {
	t.Setenv("CONTROL_PLANE_URL", "https://api.example.com")
	t.Setenv("WORKSPACE_ID", "ws-test")
	t.Setenv("CODEX_RUNTIME_INSTALL_TIMEOUT", "")
	t.Setenv("CODEX_RUNTIME_INSTALL_KILL_GRACE", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CodexRuntimeInstallTimeout != DefaultCodexRuntimeInstallTimeout || cfg.CodexRuntimeInstallKillGrace != DefaultCodexRuntimeInstallKillGrace {
		t.Fatal("unexpected default install bounds")
	}
	t.Setenv("CODEX_RUNTIME_INSTALL_TIMEOUT", "2m")
	t.Setenv("CODEX_RUNTIME_INSTALL_KILL_GRACE", "3s")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.CodexRuntimeInstallTimeout != 2*time.Minute || cfg.CodexRuntimeInstallKillGrace != 3*time.Second {
		t.Fatal("configured install bounds ignored")
	}
}
