package acp

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsSecretEnvVar(t *testing.T) {
	t.Parallel()

	tests := []struct {
		entry    string
		isSecret bool
	}{
		// Known secret names
		{"ANTHROPIC_API_KEY=sk-ant-123", true},
		{"CLAUDE_CODE_OAUTH_TOKEN=tok-abc", true},
		{"OPENAI_API_KEY=sk-oai-456", true},
		{"GH_TOKEN=ghp_abc123", true},
		{"GEMINI_API_KEY=gemini-key", true},
		{"MISTRAL_API_KEY=mistral-key", true},
		{"OPENCODE_API_KEY=opencode-key", true},

		// Substring matches
		{"CUSTOM_API_KEY=some-key", true},
		{"MY_SECRET=foo", true},
		{"AUTH_TOKEN=bar", true},
		{"SOME_DB_SECRET_VALUE=x", true},

		// Non-secret vars
		{"SAM_WORKSPACE_ID=ws-123", false},
		{"SAM_API_URL=https://api.example.com", false},
		{"VIBE_CLIENT_NAME=sam", false},
		{"HOME=/home/user", false},
		{"PATH=/usr/bin", false},

		// Edge cases
		{"", false},         // empty
		{"NOEQUALS", false}, // no = sign
	}

	for _, tt := range tests {
		t.Run(tt.entry, func(t *testing.T) {
			t.Parallel()
			got := isSecretEnvVar(tt.entry)
			if got != tt.isSecret {
				t.Errorf("isSecretEnvVar(%q) = %v, want %v", tt.entry, got, tt.isSecret)
			}
		})
	}
}

// TestEnvFileOperations groups all tests that modify the package-level
// envFileDir variable so they run sequentially and avoid data races.
func TestEnvFileOperations(t *testing.T) {
	// NOT parallel — subtests modify the package-level envFileDir.

	t.Run("WriteSecretEnvFile_ContentAndPermissions", func(t *testing.T) {
		tmpDir := t.TempDir()
		origDir := envFileDir
		envFileDir = tmpDir
		defer func() { envFileDir = origDir }()

		secrets := []string{
			"ANTHROPIC_API_KEY=sk-ant-test-123",
			"GH_TOKEN=ghp_test456",
		}

		path, err := writeSecretEnvFile(secrets)
		if err != nil {
			t.Fatalf("writeSecretEnvFile() error = %v", err)
		}
		defer os.Remove(path)

		// Verify file is in the expected directory
		if !strings.HasPrefix(path, tmpDir+"/sam-env-") {
			t.Errorf("path = %q, want prefix %q", path, tmpDir+"/sam-env-")
		}

		// Verify file permissions are 0600
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("os.Stat(%q) error = %v", path, err)
		}
		if perm := info.Mode().Perm(); perm != 0600 {
			t.Errorf("file permissions = %o, want 0600", perm)
		}

		// Verify file content matches docker --env-file format (one KEY=VALUE per line)
		content, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("os.ReadFile(%q) error = %v", path, err)
		}
		wantContent := "ANTHROPIC_API_KEY=sk-ant-test-123\nGH_TOKEN=ghp_test456\n"
		if string(content) != wantContent {
			t.Errorf("file content = %q, want %q", string(content), wantContent)
		}
	})

	t.Run("WriteSecretEnvFile_FailsOnBadDir", func(t *testing.T) {
		origDir := envFileDir
		envFileDir = "/nonexistent/path/that/does/not/exist"
		defer func() { envFileDir = origDir }()

		_, err := writeSecretEnvFile([]string{"SECRET=value"})
		if err == nil {
			t.Fatal("writeSecretEnvFile() should fail when dir does not exist")
		}
	})

	t.Run("SecretsNotInArgs", func(t *testing.T) {
		tmpDir := t.TempDir()
		origDir := envFileDir
		envFileDir = tmpDir
		defer func() { envFileDir = origDir }()

		cfg := ProcessConfig{
			ContainerID: "test-container",
			AcpCommand:  "test-agent",
			EnvVars: []string{
				"SAM_WORKSPACE_ID=ws-123",
				"ANTHROPIC_API_KEY=sk-ant-super-secret",
				"OPENCODE_API_KEY=sk-opencode-super-secret",
				"GH_TOKEN=ghp_also_secret",
				"VIBE_CLIENT_NAME=sam",
			},
		}

		// Verify secret classification
		var secrets, nonSecrets []string
		for _, env := range cfg.EnvVars {
			if isSecretEnvVar(env) {
				secrets = append(secrets, env)
			} else {
				nonSecrets = append(nonSecrets, env)
			}
		}

		if len(secrets) != 3 {
			t.Fatalf("expected 3 secrets, got %d: %v", len(secrets), secrets)
		}
		if len(nonSecrets) != 2 {
			t.Fatalf("expected 2 non-secrets, got %d: %v", len(nonSecrets), nonSecrets)
		}

		// Verify env file is written correctly
		path, err := writeSecretEnvFile(secrets)
		if err != nil {
			t.Fatalf("writeSecretEnvFile() error = %v", err)
		}
		defer os.Remove(path)

		// Build args the same way StartProcess does
		args := []string{"exec", "-i"}
		for _, env := range nonSecrets {
			args = append(args, "-e", env)
		}
		args = append(args, "--env-file", path)
		args = append(args, cfg.ContainerID, cfg.AcpCommand)

		// Verify no secret values appear in the args
		argsStr := strings.Join(args, " ")
		if strings.Contains(argsStr, "sk-ant-super-secret") {
			t.Error("secret ANTHROPIC_API_KEY value found in command args")
		}
		if strings.Contains(argsStr, "ghp_also_secret") {
			t.Error("secret GH_TOKEN value found in command args")
		}
		if strings.Contains(argsStr, "sk-opencode-super-secret") {
			t.Error("secret OPENCODE_API_KEY value found in command args")
		}

		// Verify non-secret values DO appear in args
		if !strings.Contains(argsStr, "SAM_WORKSPACE_ID=ws-123") {
			t.Error("non-secret SAM_WORKSPACE_ID not found in command args")
		}
		if !strings.Contains(argsStr, "VIBE_CLIENT_NAME=sam") {
			t.Error("non-secret VIBE_CLIENT_NAME not found in command args")
		}

		// Verify --env-file flag is present
		if !strings.Contains(argsStr, "--env-file") {
			t.Error("--env-file flag not found in command args")
		}
	})

	t.Run("ExplicitSecretEnvKeysUseEnvFile", func(t *testing.T) {
		tmpDir := t.TempDir()
		origDir := envFileDir
		envFileDir = tmpDir
		defer func() { envFileDir = origDir }()

		cfg := ProcessConfig{
			ContainerID: "test-container",
			AcpCommand:  "test-agent",
			EnvVars: []string{
				"CUSTOM_VALUE=super-secret",
				"SAM_WORKSPACE_ID=ws-123",
			},
			SecretEnvKeys: map[string]bool{"CUSTOM_VALUE": true},
		}

		args, envFilePath, err := buildDockerExecArgs(cfg)
		if err != nil {
			t.Fatalf("buildDockerExecArgs returned error: %v", err)
		}
		defer os.Remove(envFilePath)

		argsStr := strings.Join(args, " ")
		if strings.Contains(argsStr, "super-secret") {
			t.Fatalf("explicit secret value leaked into docker args: %s", argsStr)
		}
		content, err := os.ReadFile(envFilePath)
		if err != nil {
			t.Fatalf("read env file: %v", err)
		}
		if string(content) != "CUSTOM_VALUE=super-secret\n" {
			t.Fatalf("env file content = %q", string(content))
		}
	})

	t.Run("EnvFileFailureIsFatal", func(t *testing.T) {
		origDir := envFileDir
		envFileDir = "/nonexistent/path"
		defer func() { envFileDir = origDir }()

		secrets := []string{"ANTHROPIC_API_KEY=sk-ant-secret"}

		// writeSecretEnvFile must return an error when the dir doesn't exist.
		// The implementation must NOT fall back to -e flags (which would
		// expose secrets in the process table via ps).
		_, err := writeSecretEnvFile(secrets)
		if err == nil {
			t.Fatal("expected writeSecretEnvFile to fail with nonexistent dir")
		}
	})

	t.Run("EnvFileCleanup", func(t *testing.T) {
		tmpDir := t.TempDir()
		origDir := envFileDir
		envFileDir = tmpDir
		defer func() { envFileDir = origDir }()

		path, err := writeSecretEnvFile([]string{"SECRET=value"})
		if err != nil {
			t.Fatalf("writeSecretEnvFile() error = %v", err)
		}

		// File should exist after creation (it persists until process exits)
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("env file should exist after creation: %v", err)
		}

		// Simulate cleanup that happens in AgentProcess.Wait() after process exits
		if err := os.Remove(path); err != nil {
			t.Fatalf("os.Remove() error = %v", err)
		}

		// File should be gone after cleanup
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Error("env file should not exist after removal")
		}
	})

	t.Run("UniqueNames", func(t *testing.T) {
		tmpDir := t.TempDir()
		origDir := envFileDir
		envFileDir = tmpDir
		defer func() { envFileDir = origDir }()

		path1, err := writeSecretEnvFile([]string{"A=1"})
		if err != nil {
			t.Fatalf("first writeSecretEnvFile() error = %v", err)
		}
		defer os.Remove(path1)

		path2, err := writeSecretEnvFile([]string{"B=2"})
		if err != nil {
			t.Fatalf("second writeSecretEnvFile() error = %v", err)
		}
		defer os.Remove(path2)

		if path1 == path2 {
			t.Errorf("two env files should have different paths, both got %q", path1)
		}

		if filepath.Dir(path1) != tmpDir || filepath.Dir(path2) != tmpDir {
			t.Errorf("files not in expected directory: %q, %q", path1, path2)
		}
	})
}

func TestStartProcess_NoSecretsNoEnvFile(t *testing.T) {
	t.Parallel()

	// When there are no secrets, no env file should be created
	envVars := []string{
		"SAM_WORKSPACE_ID=ws-123",
		"SAM_API_URL=https://api.example.com",
		"VIBE_CLIENT_NAME=sam",
	}

	var secrets []string
	for _, env := range envVars {
		if isSecretEnvVar(env) {
			secrets = append(secrets, env)
		}
	}

	if len(secrets) != 0 {
		t.Errorf("expected no secrets in non-secret env vars, got %d: %v", len(secrets), secrets)
	}
}

func TestStartLocalProcessRunsWithoutDockerExec(t *testing.T) {
	t.Parallel()

	proc, err := StartLocalProcess(ProcessConfig{
		AcpCommand: "/bin/sh",
		AcpArgs:    []string{"-c", "printf '%s' \"$SAM_TEST_VALUE\""},
		EnvVars:    []string{"SAM_TEST_VALUE=local-ok"},
	})
	if err != nil {
		t.Fatalf("StartLocalProcess returned error: %v", err)
	}

	output, err := io.ReadAll(proc.Stdout())
	if err != nil {
		t.Fatalf("failed to read stdout: %v", err)
	}
	if err := proc.Wait(); err != nil {
		t.Fatalf("process wait returned error: %v", err)
	}
	if string(output) != "local-ok" {
		t.Fatalf("stdout=%q, want local-ok", string(output))
	}
	if proc.containerID != "" {
		t.Fatalf("local process containerID=%q, want empty", proc.containerID)
	}
}

// TestStartLocalProcessCreatesMissingWorkDir is the regression test for the
// standalone cf-container chdir bug: the ACP process work dir is derived as
// /workspaces/<repo>, which does not exist in standalone mode. Before the fix,
// Go's forkExec chdir failed with ENOENT (misreported as a missing binary).
// startLocalProcess must create the work dir and run the process in it.
func TestStartLocalProcessCreatesMissingWorkDir(t *testing.T) {
	t.Parallel()

	// A nested, not-yet-created dir mimicking /workspaces/<repo>.
	workDir := filepath.Join(t.TempDir(), "workspaces", "some-repo")
	if _, err := os.Stat(workDir); !os.IsNotExist(err) {
		t.Fatalf("precondition: work dir should not exist yet")
	}

	proc, err := StartLocalProcess(ProcessConfig{
		AcpCommand: "/bin/sh",
		AcpArgs:    []string{"-c", "pwd"},
		WorkDir:    workDir,
	})
	if err != nil {
		t.Fatalf("StartLocalProcess with missing work dir: %v", err)
	}
	output, err := io.ReadAll(proc.Stdout())
	if err != nil {
		t.Fatalf("read stdout: %v", err)
	}
	if err := proc.Wait(); err != nil {
		t.Fatalf("wait: %v", err)
	}
	if info, statErr := os.Stat(workDir); statErr != nil || !info.IsDir() {
		t.Fatalf("work dir was not created: stat err=%v", statErr)
	}
	if got := strings.TrimSpace(string(output)); got != workDir {
		t.Fatalf("process cwd=%q, want %q", got, workDir)
	}
}
