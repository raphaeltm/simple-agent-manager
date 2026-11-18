package bootstrap

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/workspace/vm-agent/internal/config"
)

func TestHostedArtifactsHelperPorts(t *testing.T) {
	for _, host := range []string{"api.sam.example", "api.sam.example:443", "api.sam.example:0443", "api.sam.example:"} {
		t.Run(host, func(t *testing.T) { assertHostedArtifactsHelper(t, "https", host, true) })
	}
	t.Run("HTTP refused", func(t *testing.T) { assertHostedArtifactsHelper(t, "http", "api.sam.example:443", false) })
}

func assertHostedArtifactsHelper(t *testing.T, protocol, host string, allowed bool) {
	t.Helper()
	cfg := &config.Config{Port: 8080, CallbackToken: "callback-not-in-script", WorkspaceID: "ws-helper-ports", RepoProvider: "artifacts", RepositoryHost: "api.sam.example"}
	script, err := renderGitCredentialHelperScript(cfg, testGitCredentialExchangeToken)
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	logPath := filepath.Join(dir, "curl.log")
	// The local exchange network boundary records the untouched query. Its real
	// binding/response refusal cases are exercised by the server route tests.
	shim := fmt.Sprintf("#!/bin/sh\nprintf '%%s\\n' \"$@\" > %s\nprintf 'username=x\\npassword=test-only\\n'\n", shellSingleQuote(logPath))
	if err := os.WriteFile(filepath.Join(dir, "curl"), []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "-c", script, "git-credential-sam", "get")
	cmd.Env = append(os.Environ(), "PATH="+dir+":"+os.Getenv("PATH"))
	cmd.Stdin = strings.NewReader("protocol=" + protocol + "\nhost=" + host + "\npath=git/repo.git\n\n")
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper execution: %v", err)
	}
	args, readErr := os.ReadFile(logPath)
	if !allowed {
		if len(output) != 0 || !os.IsNotExist(readErr) {
			t.Fatal("HTTP request reached the credential exchange")
		}
		return
	}
	if readErr != nil || !strings.Contains(string(args), "host="+host) || !strings.Contains(string(output), "password=test-only") {
		t.Fatal("HTTPS authority did not reach the local credential exchange unchanged")
	}
	if strings.Contains(script, cfg.CallbackToken) {
		t.Fatal("helper exposed the broader callback bearer")
	}
}
