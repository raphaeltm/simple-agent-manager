package server

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/agentsessions"
	"github.com/workspace/vm-agent/internal/config"
)

func TestCreateHomeTarExcludesCachesAndRecordsOversizedFiles(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, ".codex-session.jsonl"), []byte("session"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, ".cache"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, ".cache", "ignored"), []byte("cache"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "large.bin"), []byte("0123456789"), 0o600); err != nil {
		t.Fatal(err)
	}

	tarPath, skipped, err := createHomeTar(func() (string, error) { return home, nil }, 8, 1024)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(tarPath)

	if len(skipped) != 1 {
		t.Fatalf("skipped len = %d, want 1: %#v", len(skipped), skipped)
	}
	if skipped[0].Path != "~/large.bin" {
		t.Fatalf("skipped path = %q, want ~/large.bin", skipped[0].Path)
	}

	names := tarNames(t, tarPath)
	if !containsString(names, ".codex-session.jsonl") {
		t.Fatalf("tar names missing session file: %#v", names)
	}
	if containsString(names, ".cache/ignored") {
		t.Fatalf("tar names included cache file: %#v", names)
	}
	if containsString(names, "large.bin") {
		t.Fatalf("tar names included oversized file: %#v", names)
	}
}

func TestCreateWIPBundleDegradesDuringMerge(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.email", "sam@example.test")
	runGit(t, repo, "config", "user.name", "SAM")
	if err := os.WriteFile(filepath.Join(repo, "README.md"), []byte("base"), 0o600); err != nil {
		t.Fatal(err)
	}
	runGit(t, repo, "add", "README.md")
	runGit(t, repo, "commit", "-m", "base")
	if err := os.WriteFile(filepath.Join(repo, ".git", "MERGE_HEAD"), []byte("deadbeef"), 0o600); err != nil {
		t.Fatal(err)
	}

	_, bundlePath, skipped, err := createWIPBundle(context.Background(), repo, 1024)
	if err != nil {
		t.Fatal(err)
	}
	if bundlePath != "" {
		t.Fatalf("bundlePath = %q, want empty during merge", bundlePath)
	}
	if len(skipped) != 1 || skipped[0].Reason != "git operation in progress" {
		t.Fatalf("skipped = %#v, want git operation degradation", skipped)
	}
}

func TestSnapshotHarnessResumeIdentity(t *testing.T) {
	homeArtifact := map[string]snapshotArtifact{
		"home": {SizeBytes: 42, SHA256: strings.Repeat("a", sha256.Size*2)},
	}
	tests := []struct {
		name          string
		manifest      *snapshotManifest
		sessionID     string
		agentType     string
		wantACP       string
		wantAgentType string
		wantErr       bool
	}{
		{
			name: "restores exact saved harness",
			manifest: &snapshotManifest{
				AgentSessionID: "agent-session-1",
				AcpSessionID:   "acp-session-1",
				AgentType:      "openai-codex",
				Artifacts:      homeArtifact,
			},
			sessionID:     "agent-session-1",
			agentType:     "openai-codex",
			wantACP:       "acp-session-1",
			wantAgentType: "openai-codex",
		},
		{
			name:      "rejects nil manifest",
			manifest:  nil,
			sessionID: "agent-session-1",
			agentType: "openai-codex",
			wantErr:   true,
		},
		{
			name:      "rejects legacy snapshot without harness identity",
			manifest:  &snapshotManifest{AgentSessionID: "agent-session-1", Artifacts: homeArtifact},
			sessionID: "agent-session-1",
			agentType: "openai-codex",
			wantErr:   true,
		},
		{
			name: "rejects transcript-only manifest even with stale harness identity",
			manifest: &snapshotManifest{
				AgentSessionID: "agent-session-1",
				AcpSessionID:   "01M03VPM6YHABMEGH4ZHA853DA",
				AgentType:      "claude-code",
				Artifacts:      map[string]snapshotArtifact{},
			},
			sessionID: "agent-session-1",
			agentType: "claude-code",
			wantErr:   true,
		},
		{
			name: "allows replacement control session while restoring saved harness",
			manifest: &snapshotManifest{
				AgentSessionID: "agent-session-other",
				AcpSessionID:   "acp-session-1",
				AgentType:      "openai-codex",
				Artifacts:      homeArtifact,
			},
			sessionID:     "agent-session-1",
			agentType:     "openai-codex",
			wantACP:       "acp-session-1",
			wantAgentType: "openai-codex",
		},
		{
			name: "rejects agent type mismatch",
			manifest: &snapshotManifest{
				AgentSessionID: "agent-session-1",
				AcpSessionID:   "acp-session-1",
				AgentType:      "claude-code",
				Artifacts:      homeArtifact,
			},
			sessionID: "agent-session-1",
			agentType: "openai-codex",
			wantErr:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			acpSessionID, agentType, err := snapshotHarnessResumeIdentity(tt.manifest, tt.sessionID, tt.agentType)
			if tt.wantErr {
				if err == nil {
					t.Fatal("snapshotHarnessResumeIdentity returned nil error")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if acpSessionID != tt.wantACP || agentType != tt.wantAgentType {
				t.Fatalf("identity = (%q, %q), want (%q, %q)", acpSessionID, agentType, tt.wantACP, tt.wantAgentType)
			}
		})
	}
}

func TestPrepareFreshSessionAfterDegradedRestoreClearsStrictRestoreState(t *testing.T) {
	s := newContractTestServer()
	workspaceID := "ws-existing"
	sessionID := "agent-session-1"
	session, _, err := s.agentSessions.Create(workspaceID, sessionID, "Restored session", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := s.agentSessions.UpdateAcpSessionID(workspaceID, sessionID, "acp-session-old", "claude-code"); err != nil {
		t.Fatal(err)
	}
	if err := s.agentSessions.MarkError(workspaceID, sessionID, "claude-code", "ACP LoadSession failed"); err != nil {
		t.Fatal(err)
	}
	hostKey := workspaceID + ":" + sessionID
	s.sessionHosts[hostKey] = acp.NewSessionHost(acp.SessionHostConfig{
		GatewayConfig: acp.GatewayConfig{
			WorkspaceID:          workspaceID,
			SessionID:            session.ID,
			PreviousAcpSessionID: "acp-session-old",
			PreviousAgentType:    "claude-code",
			SessionManager:       s.agentSessions,
		},
	})

	s.prepareFreshSessionAfterDegradedRestore(workspaceID, sessionID, errors.New("ACP LoadSession failed"))

	if _, ok := s.sessionHosts[hostKey]; ok {
		t.Fatal("degraded restore fallback left a cached SessionHost with stale LoadSession identity")
	}
	cleared, ok := s.agentSessions.Get(workspaceID, sessionID)
	if !ok {
		t.Fatal("agent session was removed; fallback must keep the control-plane routing session")
	}
	if cleared.Status != agentsessions.StatusRunning {
		t.Fatalf("session status = %s, want %s", cleared.Status, agentsessions.StatusRunning)
	}
	if cleared.AcpSessionID != "" || cleared.AgentType != "" {
		t.Fatalf("ACP identity = (%q, %q), want cleared for fresh fallback", cleared.AcpSessionID, cleared.AgentType)
	}
	if cleared.Error != "" {
		t.Fatalf("session error = %q, want cleared for fresh fallback", cleared.Error)
	}
}

func TestBuildContainerHomeArchiveList(t *testing.T) {
	inventory := []byte(strings.Join([]string{
		"d", "0", "700", ".codex",
		"f", "7", "600", ".codex/session.jsonl",
		"f", "8", "600", ".codex/auth.json",
		"f", "8", "600", ".codex/config.toml",
		"d", "0", "755", ".cache",
		"f", "5", "600", ".cache/tool",
		"f", "12", "600", "large.bin",
		"l", "4", "777", "linked",
		"f", "4", "600", "notes.txt",
		"",
	}, "\x00"))

	fileList, skipped, selectedBytes, err := buildContainerHomeArchiveList(inventory, 10, 20)
	if err != nil {
		t.Fatal(err)
	}
	want := ".codex\x00.codex/session.jsonl\x00notes.txt\x00"
	if string(fileList) != want {
		t.Fatalf("archive list = %q, want %q", fileList, want)
	}
	if selectedBytes != 11 {
		t.Fatalf("selected bytes = %d, want 11", selectedBytes)
	}
	if len(skipped) != 2 {
		t.Fatalf("skipped = %#v, want large and symlink entries", skipped)
	}
	if skipped[0].Path != "~/large.bin" || skipped[1].Path != "~/linked" {
		t.Fatalf("skipped = %#v", skipped)
	}
}

func TestBuildContainerHomeArchiveListPrioritizesHarnessStateUnderBudgetPressure(t *testing.T) {
	inventory := []byte(strings.Join([]string{
		"f", "18", "600", "ordinary-first.log",
		"d", "0", "700", ".claude",
		"f", "7", "600", ".claude/session.jsonl",
		"d", "0", "700", ".codex",
		"f", "8", "600", ".codex/session.jsonl",
		"f", "4", "600", "notes.txt",
		"",
	}, "\x00"))

	fileList, skipped, selectedBytes, err := buildContainerHomeArchiveList(inventory, 50, 20)
	if err != nil {
		t.Fatal(err)
	}
	want := ".claude\x00.claude/session.jsonl\x00.codex\x00.codex/session.jsonl\x00notes.txt\x00"
	if string(fileList) != want {
		t.Fatalf("archive list = %q, want %q", fileList, want)
	}
	if selectedBytes != 19 {
		t.Fatalf("selected bytes = %d, want 19", selectedBytes)
	}
	if len(skipped) != 1 || skipped[0].Path != "~/ordinary-first.log" || skipped[0].Reason != "snapshot budget exhausted" {
		t.Fatalf("skipped = %#v, want ordinary file skipped after harness selection", skipped)
	}
}

func TestBuildContainerHomeArchiveListRejectsEntryFlood(t *testing.T) {
	var inventory bytes.Buffer
	for index := 0; index <= defaultSnapshotMaxArchiveEntries; index++ {
		inventory.WriteString("f\x001\x00600\x00entry-")
		inventory.WriteString(strconv.Itoa(index))
		inventory.WriteByte(0)
	}
	if _, _, _, err := buildContainerHomeArchiveList(inventory.Bytes(), 10, 1<<30); err == nil || !strings.Contains(err.Error(), "entry limit") {
		t.Fatalf("error = %v, want entry limit rejection", err)
	}
}

func TestCappedSnapshotBuffersStopGrowth(t *testing.T) {
	buffer := &cappedBuffer{maxBytes: 4}
	if n, err := buffer.Write([]byte("overflow")); err != nil || n != len("overflow") {
		t.Fatalf("buffer write = (%d, %v)", n, err)
	}
	if !buffer.exceeded || buffer.buffer.Len() != 4 {
		t.Fatalf("buffer state = exceeded %v, bytes %d", buffer.exceeded, buffer.buffer.Len())
	}
	path := filepath.Join(t.TempDir(), "artifact")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := &cappedFileWriter{file: file, remaining: 4}
	if _, err := writer.Write([]byte("overflow")); !errors.Is(err, errSnapshotArtifactLimit) {
		t.Fatalf("file writer error = %v, want artifact limit", err)
	}
	_ = file.Close()
	if info, err := os.Stat(path); err != nil || info.Size() != 4 {
		t.Fatalf("bounded artifact size = %v, %v", info, err)
	}
}

func TestValidateSnapshotHomeTarRejectsUnsafeEntries(t *testing.T) {
	tests := []struct {
		name           string
		header         tar.Header
		body           string
		entryThreshold int64
		totalBudget    int64
	}{
		{
			name:           "path traversal",
			header:         tar.Header{Name: "../outside", Mode: 0o600, Typeflag: tar.TypeReg, Size: 1},
			body:           "x",
			entryThreshold: 10,
			totalBudget:    10,
		},
		{
			name:           "credential file",
			header:         tar.Header{Name: ".codex/auth.json", Mode: 0o600, Typeflag: tar.TypeReg, Size: 1},
			body:           "x",
			entryThreshold: 10,
			totalBudget:    10,
		},
		{
			name:           "generated runtime config",
			header:         tar.Header{Name: ".vibe/config.toml", Mode: 0o600, Typeflag: tar.TypeReg, Size: 1},
			body:           "x",
			entryThreshold: 10,
			totalBudget:    10,
		},
		{
			name:           "symbolic link",
			header:         tar.Header{Name: "link", Mode: 0o777, Typeflag: tar.TypeSymlink, Linkname: "/tmp"},
			entryThreshold: 10,
			totalBudget:    10,
		},
		{
			name:           "hard link",
			header:         tar.Header{Name: "hard", Mode: 0o600, Typeflag: tar.TypeLink, Linkname: "target"},
			entryThreshold: 10,
			totalBudget:    10,
		},
		{
			name:           "entry threshold",
			header:         tar.Header{Name: "large", Mode: 0o600, Typeflag: tar.TypeReg, Size: 2},
			body:           "xx",
			entryThreshold: 1,
			totalBudget:    10,
		},
		{
			name:           "total budget",
			header:         tar.Header{Name: "large", Mode: 0o600, Typeflag: tar.TypeReg, Size: 2},
			body:           "xx",
			entryThreshold: 10,
			totalBudget:    1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "home.tar")
			file, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			writer := tar.NewWriter(file)
			if err := writer.WriteHeader(&tt.header); err != nil {
				t.Fatal(err)
			}
			if tt.body != "" {
				if _, err := writer.Write([]byte(tt.body)); err != nil {
					t.Fatal(err)
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}

			if _, err := validateSnapshotHomeTar(path, tt.entryThreshold, tt.totalBudget); err == nil {
				t.Fatal("validateSnapshotHomeTar returned nil error")
			}
		})
	}
}

func TestValidateSnapshotHomeTarAcceptsHarnessState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "home.tar")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := tar.NewWriter(file)
	writeTarFile(t, writer, ".codex/sessions/session.jsonl", "remember me")
	writeTarFile(t, writer, ".local/share/opencode/session.json", "remember me too")
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	names, err := validateSnapshotHomeTar(path, 1024, 2048)
	if err != nil {
		t.Fatal(err)
	}
	if !containsString(names, ".codex/sessions/session.jsonl") ||
		!containsString(names, ".local/share/opencode/session.json") {
		t.Fatalf("validated names = %#v", names)
	}
}

func TestValidateSnapshotHomeTarRejectsReservedRootAbuseAndConflicts(t *testing.T) {
	tests := []struct {
		name    string
		headers []tar.Header
	}{
		{
			name:    "unknown reserved root",
			headers: []tar.Header{{Name: snapshotExternalRootsPrefix + "/unknown/state", Mode: 0o600, Typeflag: tar.TypeReg, Size: 1}},
		},
		{
			name: "duplicate normalized path",
			headers: []tar.Header{
				{Name: "notes/../state", Mode: 0o600, Typeflag: tar.TypeReg, Size: 1},
				{Name: "state", Mode: 0o600, Typeflag: tar.TypeReg, Size: 1},
			},
		},
		{
			name: "regular file conflicts with prior child",
			headers: []tar.Header{
				{Name: "parent/child", Mode: 0o600, Typeflag: tar.TypeReg, Size: 1},
				{Name: "parent", Mode: 0o600, Typeflag: tar.TypeReg, Size: 1},
			},
		},
		{
			name:    "external credential",
			headers: []tar.Header{{Name: snapshotExternalRootsPrefix + "/codex/auth.json", Mode: 0o600, Typeflag: tar.TypeReg, Size: 1}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state.tar")
			file, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			writer := tar.NewWriter(file)
			for index := range test.headers {
				header := test.headers[index]
				if err := writer.WriteHeader(&header); err != nil {
					t.Fatal(err)
				}
				if header.Size > 0 {
					if _, err := writer.Write(bytes.Repeat([]byte{'x'}, int(header.Size))); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			if _, err := validateSnapshotHomeTar(path, 1024, 4096); err == nil {
				t.Fatal("validateSnapshotHomeTar returned nil error")
			}
		})
	}
}

func TestContainerSnapshotTarDereferencesHardLinksAndNamespacesExternalRoot(t *testing.T) {
	args := containerSnapshotTarArgs(
		snapshotArchiveRoot{logicalName: snapshotRootCodex, path: "/workspace/project/.codex"},
		"-rf",
		"/tmp/state.tar",
	)
	joined := strings.Join(args, "\x00")
	for _, required := range []string{
		"--hard-dereference",
		"--transform\x00s,^," + snapshotExternalRootsPrefix + "/codex/,",
	} {
		if !strings.Contains(joined, required) {
			t.Fatalf("tar args = %#v, missing %q", args, required)
		}
	}
}

func TestUploadSnapshotFileSendsPrecomputedChecksum(t *testing.T) {
	body := []byte("persistent session state")
	expectedSum := sha256.Sum256(body)
	expectedSHA := hex.EncodeToString(expectedSum[:])
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("X-SAM-Content-SHA256"); got != expectedSHA {
			t.Errorf("X-SAM-Content-SHA256 = %q, want %q", got, expectedSHA)
		}
		got, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		if !bytes.Equal(got, body) {
			t.Errorf("uploaded body = %q, want %q", got, body)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "state.tar")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	size, digest, err := s.uploadSnapshotFile(context.Background(), server.URL, path, "token", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if size != int64(len(body)) || digest != expectedSHA {
		t.Fatalf("upload result = (%d, %q), want (%d, %q)", size, digest, len(body), expectedSHA)
	}
}

func TestUploadSessionSnapshotArtifactUsesAuthorizedDirectURL(t *testing.T) {
	body := []byte("large persistent session state")
	expectedSum := sha256.Sum256(body)
	expectedSHA := hex.EncodeToString(expectedSum[:])
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/authorize":
			if got := r.Header.Get("Authorization"); got != "Bearer callback-token" {
				t.Errorf("authorization header = %q", got)
			}
			var payload struct {
				SizeBytes      int64  `json:"sizeBytes"`
				SHA256         string `json:"sha256"`
				ChecksumHeader bool   `json:"checksumHeader"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
			}
			if payload.SizeBytes != int64(len(body)) || payload.SHA256 != expectedSHA {
				t.Errorf("authorization payload = %#v", payload)
			}
			if !payload.ChecksumHeader {
				t.Errorf("checksumHeader = false, want true")
			}
			writeJSON(w, http.StatusOK, map[string]string{"uploadUrl": server.URL + "/r2"})
		case "/r2":
			if got := r.Header.Get("Authorization"); got != "" {
				t.Errorf("direct R2 request leaked authorization header %q", got)
			}
			if got := r.Header.Get("x-amz-checksum-sha256"); got != base64.StdEncoding.EncodeToString(expectedSum[:]) {
				t.Errorf("x-amz-checksum-sha256 = %q", got)
			}
			if r.ContentLength != int64(len(body)) {
				t.Errorf("content length = %d, want %d", r.ContentLength, len(body))
			}
			got, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
			}
			if !bytes.Equal(got, body) {
				t.Errorf("uploaded body = %q, want %q", got, body)
			}
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	path := filepath.Join(t.TempDir(), "state.tar")
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	size, digest, err := s.uploadSessionSnapshotArtifact(context.Background(), "/legacy", server.URL+"/authorize", path, "callback-token", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if size != int64(len(body)) || digest != expectedSHA {
		t.Fatalf("upload result = (%d, %q), want (%d, %q)", size, digest, len(body), expectedSHA)
	}
}

func TestPrepareSnapshotAdvertisesDirectUploadSupport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["directUploadSupported"] != true {
			t.Errorf("directUploadSupported = %#v, want true", payload["directUploadSupported"])
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"generation": "generation-1",
		})
	}))
	defer server.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	prepared, err := s.prepareSnapshot(
		context.Background(),
		"workspace-1",
		"agent-session-1",
		"chat-1",
		"vm",
		"callback-token",
	)
	if err != nil {
		t.Fatal(err)
	}
	if prepared.Generation != "generation-1" {
		t.Fatalf("generation = %q, want generation-1", prepared.Generation)
	}
}

func TestReportSnapshotProgressPostsGeneration(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/workspace-1/session-snapshot/progress" {
			t.Fatalf("request path = %q", r.URL.Path)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer callback-token" {
			t.Fatalf("authorization = %q", got)
		}
		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if payload["chatSessionId"] != "chat-1" || payload["generation"] != "generation-1" || payload["step"] != "home-walk" {
			t.Fatalf("payload = %#v", payload)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.reportSnapshotProgress(context.Background(), "workspace-1", "chat-1", "generation-1", "home-walk", "callback-token"); err != nil {
		t.Fatal(err)
	}
}

func TestSessionSnapshotUploadRelayAuthorizesBeforeStreamingWithoutBearer(t *testing.T) {
	body := []byte("legacy snapshot larger than the worker boundary")
	expectedSum := sha256.Sum256(body)
	expectedSHA := hex.EncodeToString(expectedSum[:])
	authorizationPath := "/api/workspaces/workspace-legacy/session-snapshot/artifacts/home/upload-url?chatSessionId=chat-legacy&generation=generation-1"
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workspaces/workspace-legacy/session-snapshot/artifacts/home/upload-url":
			if got := r.Header.Get("Authorization"); got != "Bearer legacy-callback-token" {
				t.Errorf("authorization header = %q", got)
			}
			if got := r.Header.Get("X-SAM-Relay-Node-ID"); got != "relay-node" {
				t.Errorf("relay node header = %q", got)
			}
			if got := r.Header.Get("X-SAM-Relay-Authorization"); got != "Bearer relay-node-token" {
				t.Errorf("relay authorization header = %q", got)
			}
			var payload struct {
				SizeBytes      int64  `json:"sizeBytes"`
				SHA256         string `json:"sha256"`
				ChecksumHeader bool   `json:"checksumHeader"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
				t.Error(err)
			}
			if payload.SizeBytes != int64(len(body)) || payload.SHA256 != expectedSHA {
				t.Errorf("authorization payload = %#v", payload)
			}
			if !payload.ChecksumHeader {
				t.Errorf("checksumHeader = false, want true")
			}
			writeJSON(w, http.StatusOK, map[string]string{"uploadUrl": server.URL + "/r2"})
		case "/r2":
			if got := r.Header.Get("Authorization"); got != "" {
				t.Errorf("relay leaked authorization header %q", got)
			}
			if got := r.Header.Get("X-SAM-Relay-Authorization"); got != "" {
				t.Errorf("relay leaked node authorization header %q", got)
			}
			if got := r.Header.Get("x-amz-checksum-sha256"); got != base64.StdEncoding.EncodeToString(expectedSum[:]) {
				t.Errorf("x-amz-checksum-sha256 = %q", got)
			}
			got, err := io.ReadAll(r.Body)
			if err != nil {
				t.Error(err)
			}
			if !bytes.Equal(got, body) {
				t.Errorf("relayed body = %q, want %q", got, body)
			}
			w.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected request path %q", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	s := &Server{config: &config.Config{
		ControlPlaneURL:                 server.URL,
		NodeID:                          "relay-node",
		SessionSnapshotOperationTimeout: time.Minute,
	}}
	s.callbackToken = "relay-node-token"
	req := httptest.NewRequest(
		http.MethodPut,
		"/session-snapshot-upload-relay?authorizationPath="+url.QueryEscape(authorizationPath),
		bytes.NewReader(body),
	)
	req.Header.Set("Authorization", "Bearer legacy-callback-token")
	req.Header.Set("X-SAM-Content-SHA256", expectedSHA)
	recorder := &snapshotRelayDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	s.handleSessionSnapshotUploadRelay(recorder, req)
	if recorder.Code != http.StatusOK {
		t.Fatalf("relay status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if remaining := time.Until(recorder.readDeadline); remaining < 55*time.Second || remaining > time.Minute {
		t.Fatalf("relay read deadline remaining = %v, want snapshot operation timeout", remaining)
	}
}

type snapshotRelayDeadlineRecorder struct {
	*httptest.ResponseRecorder
	readDeadline time.Time
}

func (r *snapshotRelayDeadlineRecorder) SetReadDeadline(deadline time.Time) error {
	r.readDeadline = deadline
	return nil
}

func TestSessionSnapshotUploadRelayRejectsExternalAuthorizationTarget(t *testing.T) {
	req := httptest.NewRequest(
		http.MethodPut,
		"/session-snapshot-upload-relay?authorizationPath="+url.QueryEscape("https://evil.example/upload"),
		bytes.NewReader([]byte("state")),
	)
	req.Header.Set("Authorization", "Bearer legacy-callback-token")
	req.Header.Set("X-SAM-Content-SHA256", strings.Repeat("a", sha256.Size*2))
	recorder := httptest.NewRecorder()
	(&Server{}).handleSessionSnapshotUploadRelay(recorder, req)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("relay status = %d, want %d", recorder.Code, http.StatusBadRequest)
	}
}

func TestCompleteSnapshotSendsPreparedGeneration(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/workspace-1/session-snapshot/complete" {
			t.Fatalf("request path = %q", r.URL.Path)
		}
		var payload map[string]interface{}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatal(err)
		}
		if got := payload["generation"]; got != "generation-1" {
			t.Errorf("generation = %#v, want generation-1", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"available"}`))
	}))
	defer server.Close()
	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	manifest := snapshotManifest{
		Version:       1,
		ChatSessionID: "chat-1",
		WorkspaceID:   "workspace-1",
		Status:        "available",
		Degradation:   "none",
		Skipped:       []snapshotSkippedEntry{},
		Artifacts:     map[string]snapshotArtifact{},
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	if err := s.completeSnapshot(context.Background(), "workspace-1", "agent-1", "chat-1", "vm", "generation-1", "callback-token", manifest); err != nil {
		t.Fatal(err)
	}
}

func TestDownloadAndExtractTarRejectsPathTraversal(t *testing.T) {
	home := t.TempDir()
	outside := filepath.Join(t.TempDir(), "outside.txt")
	absolute := filepath.Join(t.TempDir(), "absolute.txt")
	t.Setenv("HOME", home)

	var tarBody bytes.Buffer
	tw := tar.NewWriter(&tarBody)
	writeTarFile(t, tw, "session.jsonl", "inside")
	writeTarFile(t, tw, "../outside.txt", "outside")
	writeTarFile(t, tw, absolute, "absolute")
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(tarBody.Bytes())
	}))
	defer server.Close()

	s := &Server{config: &config.Config{ControlPlaneURL: server.URL}}
	if err := s.downloadAndExtractTar(context.Background(), "/artifact", "token", time.Second); err == nil {
		t.Fatal("downloadAndExtractTar returned nil error for traversal archive")
	}

	if _, err := os.Stat(filepath.Join(home, "session.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("partial extraction occurred before validation: %v", err)
	}
	if _, err := os.Stat(outside); !os.IsNotExist(err) {
		t.Fatalf("outside file stat err = %v, want not exist", err)
	}
	if _, err := os.Stat(absolute); !os.IsNotExist(err) {
		t.Fatalf("absolute file stat err = %v, want not exist", err)
	}
}

func tarNames(t *testing.T, path string) []string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	tr := tar.NewReader(f)
	var names []string
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return names
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, header.Name)
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v failed: %v\n%s", args, err, out)
	}
}

func writeTarFile(t *testing.T, tw *tar.Writer, name, body string) {
	t.Helper()
	if err := tw.WriteHeader(&tar.Header{
		Name: name,
		Mode: 0o600,
		Size: int64(len(body)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
}

func containsString(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}
