package server

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultSnapshotTotalBudgetBytes    int64         = 100 * 1024 * 1024
	defaultSnapshotEntryThresholdBytes int64         = 50 * 1024 * 1024
	defaultSnapshotTransferIdleTimeout time.Duration = 30 * time.Second
)

type snapshotPrepareResponse struct {
	ExpiresAt string `json:"expiresAt"`
	Config    struct {
		TotalBudgetBytes      int64 `json:"totalBudgetBytes"`
		EntryThresholdBytes   int64 `json:"entryThresholdBytes"`
		TransferIdleTimeoutMs int64 `json:"transferIdleTimeoutMs"`
	} `json:"config"`
	Upload struct {
		Home string `json:"home"`
		WIP  string `json:"wip"`
	} `json:"upload"`
}

type snapshotRestoreResponse struct {
	Available   bool                   `json:"available"`
	Reason      string                 `json:"reason,omitempty"`
	Status      string                 `json:"status,omitempty"`
	Degradation string                 `json:"degradation,omitempty"`
	BaseCommit  string                 `json:"baseCommit,omitempty"`
	Manifest    map[string]interface{} `json:"manifest,omitempty"`
	Download    struct {
		Home     string `json:"home"`
		WIP      string `json:"wip"`
		Manifest string `json:"manifest"`
	} `json:"download"`
}

type snapshotManifest struct {
	Version        int                         `json:"version"`
	ChatSessionID  string                      `json:"chatSessionId"`
	WorkspaceID    string                      `json:"workspaceId"`
	AgentSessionID string                      `json:"agentSessionId,omitempty"`
	BaseCommit     string                      `json:"baseCommit,omitempty"`
	Status         string                      `json:"status"`
	Degradation    string                      `json:"degradation"`
	Skipped        []snapshotSkippedEntry      `json:"skipped"`
	Artifacts      map[string]snapshotArtifact `json:"artifacts"`
	CreatedAt      string                      `json:"createdAt"`
}

type snapshotSkippedEntry struct {
	Path      string `json:"path"`
	Reason    string `json:"reason"`
	SizeBytes int64  `json:"sizeBytes,omitempty"`
}

type snapshotArtifact struct {
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256,omitempty"`
}

type countingReader struct {
	r    io.Reader
	n    int64
	hash hashWriter
}

type hashWriter interface {
	Write([]byte) (int, error)
	Sum([]byte) []byte
}

func (r *countingReader) Read(p []byte) (int, error) {
	n, err := r.r.Read(p)
	if n > 0 {
		r.n += int64(n)
		_, _ = r.hash.Write(p[:n])
	}
	return n, err
}

func (s *Server) handleHibernateAgentSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}
	var body struct {
		ChatSessionID string `json:"chatSessionId"`
		Runtime       string `json:"runtime"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.ChatSessionID = strings.TrimSpace(body.ChatSessionID)
	if body.ChatSessionID == "" {
		writeError(w, http.StatusBadRequest, "chatSessionId is required")
		return
	}
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}
	callbackToken := s.callbackTokenForWorkspace(workspaceID)
	if callbackToken == "" {
		writeError(w, http.StatusConflict, "workspace callback token unavailable")
		return
	}
	result, err := s.hibernateSessionSnapshot(r.Context(), runtime, sessionID, body.ChatSessionID, body.Runtime, callbackToken)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRestoreAgentSession(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}
	var body struct {
		ChatSessionID string `json:"chatSessionId"`
		Runtime       string `json:"runtime"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	body.ChatSessionID = strings.TrimSpace(body.ChatSessionID)
	if body.ChatSessionID == "" {
		writeError(w, http.StatusBadRequest, "chatSessionId is required")
		return
	}
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return
	}
	callbackToken := s.callbackTokenForWorkspace(workspaceID)
	if callbackToken == "" {
		writeError(w, http.StatusConflict, "workspace callback token unavailable")
		return
	}
	result, err := s.restoreSessionSnapshot(r.Context(), runtime, sessionID, body.ChatSessionID, callbackToken)
	if err != nil {
		_ = s.reportSnapshotRestoreResult(context.Background(), workspaceID, body.ChatSessionID, "degraded", err.Error(), callbackToken)
		writeJSON(w, http.StatusOK, map[string]interface{}{"status": "degraded", "message": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) hibernateSessionSnapshot(ctx context.Context, runtime *WorkspaceRuntime, sessionID, chatSessionID, runtimeName, callbackToken string) (map[string]interface{}, error) {
	prepare, err := s.prepareSnapshot(ctx, runtime.ID, sessionID, chatSessionID, runtimeName, callbackToken)
	if err != nil {
		return nil, err
	}
	totalBudget := choosePositiveInt64(prepare.Config.TotalBudgetBytes, defaultSnapshotTotalBudgetBytes)
	entryThreshold := choosePositiveInt64(prepare.Config.EntryThresholdBytes, defaultSnapshotEntryThresholdBytes)
	idleTimeout := choosePositiveDurationMs(prepare.Config.TransferIdleTimeoutMs, defaultSnapshotTransferIdleTimeout)
	manifest := snapshotManifest{
		Version:        1,
		ChatSessionID:  chatSessionID,
		WorkspaceID:    runtime.ID,
		AgentSessionID: sessionID,
		Status:         "available",
		Degradation:    "none",
		Skipped:        []snapshotSkippedEntry{},
		Artifacts:      map[string]snapshotArtifact{},
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}
	workDir := standaloneWorkspaceWorkDir(runtime, s.config.WorkspaceDir, s.config.ContainerWorkDir)
	baseCommit, wipPath, wipSkipped, err := createWIPBundle(ctx, workDir, entryThreshold)
	manifest.BaseCommit = baseCommit
	manifest.Skipped = append(manifest.Skipped, wipSkipped...)
	if err != nil {
		manifest.Skipped = append(manifest.Skipped, snapshotSkippedEntry{Path: workDir, Reason: err.Error()})
	}

	remaining := totalBudget
	if wipPath != "" {
		size, sha, uploadErr := s.uploadSnapshotFile(ctx, prepare.Upload.WIP, wipPath, callbackToken, idleTimeout)
		_ = os.Remove(wipPath)
		if uploadErr != nil {
			manifest.Skipped = append(manifest.Skipped, snapshotSkippedEntry{Path: workDir, Reason: uploadErr.Error()})
		} else {
			manifest.Artifacts["wip"] = snapshotArtifact{SizeBytes: size, SHA256: sha}
			remaining -= size
		}
	}
	homePath, homeSkipped, err := createHomeTar(os.UserHomeDir, entryThreshold, remaining)
	manifest.Skipped = append(manifest.Skipped, homeSkipped...)
	if err != nil {
		manifest.Skipped = append(manifest.Skipped, snapshotSkippedEntry{Path: "$HOME", Reason: err.Error()})
	}
	if homePath != "" {
		size, sha, uploadErr := s.uploadSnapshotFile(ctx, prepare.Upload.Home, homePath, callbackToken, idleTimeout)
		_ = os.Remove(homePath)
		if uploadErr != nil {
			manifest.Skipped = append(manifest.Skipped, snapshotSkippedEntry{Path: "$HOME", Reason: uploadErr.Error()})
		} else {
			manifest.Artifacts["home"] = snapshotArtifact{SizeBytes: size, SHA256: sha}
		}
	}
	if _, ok := manifest.Artifacts["home"]; !ok {
		manifest.Degradation = "wip-only"
	}
	if _, ok := manifest.Artifacts["wip"]; !ok {
		if manifest.Degradation == "wip-only" {
			manifest.Degradation = "transcript-only"
			manifest.Status = "degraded"
		} else {
			manifest.Degradation = "home-skipped"
			manifest.Status = "degraded"
		}
	}
	if len(manifest.Skipped) > 0 && manifest.Status == "available" {
		manifest.Status = "degraded"
	}
	err = s.completeSnapshot(ctx, runtime.ID, sessionID, chatSessionID, runtimeName, callbackToken, manifest)
	if err != nil {
		return nil, err
	}
	return map[string]interface{}{"status": manifest.Status, "degradation": manifest.Degradation, "skipped": manifest.Skipped}, nil
}

func (s *Server) restoreSessionSnapshot(ctx context.Context, runtime *WorkspaceRuntime, sessionID, chatSessionID, callbackToken string) (map[string]interface{}, error) {
	restore, err := s.fetchSnapshotRestore(ctx, runtime.ID, chatSessionID, callbackToken)
	if err != nil {
		return nil, err
	}
	if !restore.Available {
		_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "missing", restore.Reason, callbackToken)
		return map[string]interface{}{"status": "transcript-replay", "reason": restore.Reason}, nil
	}
	idleTimeout := defaultSnapshotTransferIdleTimeout
	if restore.Download.Home != "" {
		if err := s.downloadAndExtractTar(ctx, restore.Download.Home, callbackToken, idleTimeout); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "home_failed", err.Error(), callbackToken)
			return nil, err
		}
	}
	if restore.Download.WIP != "" {
		workDir := standaloneWorkspaceWorkDir(runtime, s.config.WorkspaceDir, s.config.ContainerWorkDir)
		if err := s.downloadAndRestoreWIP(ctx, restore.Download.WIP, callbackToken, idleTimeout, workDir, restore.BaseCommit); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "wip_failed", err.Error(), callbackToken)
			return nil, err
		}
	}
	if _, err := s.provisionWorkspaceRuntime(ctx, runtime); err != nil {
		_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "fresh_injection_failed", err.Error(), callbackToken)
		return nil, err
	}
	if session, exists := s.agentSessions.Get(runtime.ID, sessionID); exists {
		hostKey := runtime.ID + ":" + sessionID
		_ = s.getOrCreateSessionHost(hostKey, runtime.ID, sessionID, session, runtime, "")
	}
	_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "restored", "", callbackToken)
	return map[string]interface{}{"status": "restored", "degradation": restore.Degradation}, nil
}

func (s *Server) prepareSnapshot(ctx context.Context, workspaceID, sessionID, chatSessionID, runtimeName, token string) (*snapshotPrepareResponse, error) {
	payload := map[string]string{"chatSessionId": chatSessionID, "agentSessionId": sessionID, "runtime": runtimeName}
	var out snapshotPrepareResponse
	err := s.doSnapshotJSON(ctx, http.MethodPost, workspaceID, "/session-snapshot/prepare", token, payload, &out)
	return &out, err
}

func (s *Server) completeSnapshot(ctx context.Context, workspaceID, sessionID, chatSessionID, runtimeName, token string, manifest snapshotManifest) error {
	artifactSizes := map[string]int64{}
	if artifact, ok := manifest.Artifacts["home"]; ok {
		artifactSizes["homeBytes"] = artifact.SizeBytes
	}
	if artifact, ok := manifest.Artifacts["wip"]; ok {
		artifactSizes["wipBytes"] = artifact.SizeBytes
	}
	payload := map[string]interface{}{
		"chatSessionId":  chatSessionID,
		"agentSessionId": sessionID,
		"runtime":        runtimeName,
		"baseCommit":     manifest.BaseCommit,
		"status":         manifest.Status,
		"degradation":    manifest.Degradation,
		"manifest":       manifest,
		"artifactSizes":  artifactSizes,
	}
	var out map[string]interface{}
	return s.doSnapshotJSON(ctx, http.MethodPost, workspaceID, "/session-snapshot/complete", token, payload, &out)
}

func (s *Server) fetchSnapshotRestore(ctx context.Context, workspaceID, chatSessionID, token string) (*snapshotRestoreResponse, error) {
	path := "/session-snapshot/restore?chatSessionId=" + url.QueryEscape(chatSessionID)
	var out snapshotRestoreResponse
	err := s.doSnapshotJSON(ctx, http.MethodGet, workspaceID, path, token, nil, &out)
	return &out, err
}

func (s *Server) reportSnapshotRestoreResult(ctx context.Context, workspaceID, chatSessionID, status, message, token string) error {
	payload := map[string]string{"chatSessionId": chatSessionID, "status": status, "message": message}
	var out map[string]interface{}
	return s.doSnapshotJSON(ctx, http.MethodPost, workspaceID, "/session-snapshot/restore-result", token, payload, &out)
}

func (s *Server) doSnapshotJSON(ctx context.Context, method, workspaceID, path, token string, payload interface{}, out interface{}) error {
	endpoint := strings.TrimRight(s.config.ControlPlaneURL, "/") + "/api/workspaces/" + url.PathEscape(workspaceID) + path
	var body io.Reader
	if payload != nil {
		data, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, endpoint, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1024*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("snapshot control plane returned HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(data)))
	}
	if out != nil && len(data) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return err
		}
	}
	return nil
}

func createWIPBundle(ctx context.Context, workDir string, entryThreshold int64) (string, string, []snapshotSkippedEntry, error) {
	if ok, err := standaloneRepositoryPresent(workDir); err != nil || !ok {
		if err != nil {
			return "", "", nil, err
		}
		return "", "", nil, nil
	}
	if gitOperationInProgress(workDir) {
		return "", "", []snapshotSkippedEntry{{Path: workDir, Reason: "git operation in progress"}}, nil
	}
	base, err := runStandaloneGitCommand(ctx, workDir, nil, "rev-parse", "HEAD")
	if err != nil {
		return "", "", nil, fmt.Errorf("resolve base commit: %w", err)
	}
	status, err := runStandaloneGitCommand(ctx, workDir, nil, "status", "--porcelain")
	if err != nil {
		return base, "", nil, fmt.Errorf("git status: %w", err)
	}
	if strings.TrimSpace(status) == "" {
		return base, "", nil, nil
	}
	skipped := skipOversizedUntracked(workDir, entryThreshold)
	_, _ = runStandaloneGitCommand(ctx, workDir, nil, "add", "-A")
	for _, entry := range skipped {
		if entry.Path != "" {
			_, _ = runStandaloneGitCommand(ctx, workDir, nil, "reset", "--", entry.Path)
		}
	}
	if _, err := runStandaloneGitCommand(ctx, workDir, nil, "commit", "--no-verify", "-m", "SAM session snapshot"); err != nil {
		return base, "", skipped, fmt.Errorf("create temporary snapshot commit: %w", err)
	}
	bundle, err := os.CreateTemp("", "sam-session-wip-*.bundle")
	if err != nil {
		return base, "", skipped, err
	}
	bundlePath := bundle.Name()
	_ = bundle.Close()
	if _, err := runStandaloneGitCommand(ctx, workDir, nil, "bundle", "create", bundlePath, base+"..HEAD"); err != nil {
		_, _ = runStandaloneGitCommand(ctx, workDir, nil, "reset", "--mixed", base)
		_ = os.Remove(bundlePath)
		return base, "", skipped, fmt.Errorf("create git bundle: %w", err)
	}
	_, _ = runStandaloneGitCommand(ctx, workDir, nil, "reset", "--mixed", base)
	return base, bundlePath, skipped, nil
}

func gitOperationInProgress(workDir string) bool {
	gitDir := filepath.Join(workDir, ".git")
	for _, marker := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"} {
		if _, err := os.Stat(filepath.Join(gitDir, marker)); err == nil {
			return true
		}
	}
	return false
}

func skipOversizedUntracked(workDir string, threshold int64) []snapshotSkippedEntry {
	var skipped []snapshotSkippedEntry
	_ = filepath.WalkDir(workDir, func(path string, d os.DirEntry, err error) error {
		if err != nil || path == workDir {
			return nil
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if d.IsDir() {
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil || info.Size() <= threshold {
			return nil
		}
		rel, _ := filepath.Rel(workDir, path)
		if out, gitErr := runStandaloneGitCommand(context.Background(), workDir, nil, "check-ignore", "-q", rel); gitErr == nil && strings.TrimSpace(out) == "" {
			return nil
		}
		skipped = append(skipped, snapshotSkippedEntry{Path: rel, Reason: "entry exceeds size threshold", SizeBytes: info.Size()})
		return nil
	})
	return skipped
}

func createHomeTar(homeDirFn func() (string, error), entryThreshold, totalBudget int64) (string, []snapshotSkippedEntry, error) {
	home, err := homeDirFn()
	if err != nil {
		return "", nil, err
	}
	home = filepath.Clean(home)
	out, err := os.CreateTemp("", "sam-session-home-*.tar")
	if err != nil {
		return "", nil, err
	}
	path := out.Name()
	tw := tar.NewWriter(out)
	var written int64
	var skipped []snapshotSkippedEntry
	walkErr := filepath.WalkDir(home, func(path string, d os.DirEntry, err error) error {
		if err != nil || path == home {
			return nil
		}
		rel, _ := filepath.Rel(home, path)
		if shouldExcludeHomePath(rel) {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, statErr := d.Info()
		if statErr != nil {
			return nil
		}
		if info.Size() > entryThreshold {
			skipped = append(skipped, snapshotSkippedEntry{Path: "~/" + rel, Reason: "entry exceeds size threshold", SizeBytes: info.Size()})
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !info.IsDir() && written+info.Size() > totalBudget {
			skipped = append(skipped, snapshotSkippedEntry{Path: "~/" + rel, Reason: "snapshot budget exhausted", SizeBytes: info.Size()})
			return nil
		}
		header, headerErr := tar.FileInfoHeader(info, "")
		if headerErr != nil {
			return nil
		}
		header.Name = rel
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			f, openErr := os.Open(path)
			if openErr != nil {
				return nil
			}
			n, copyErr := io.Copy(tw, f)
			_ = f.Close()
			written += n
			if copyErr != nil {
				return copyErr
			}
		}
		return nil
	})
	closeErr := tw.Close()
	fileCloseErr := out.Close()
	if walkErr != nil || closeErr != nil || fileCloseErr != nil {
		_ = os.Remove(path)
		if walkErr != nil {
			return "", skipped, walkErr
		}
		if closeErr != nil {
			return "", skipped, closeErr
		}
		return "", skipped, fileCloseErr
	}
	return path, skipped, nil
}

func shouldExcludeHomePath(rel string) bool {
	first := strings.Split(filepath.ToSlash(rel), "/")[0]
	switch first {
	case ".cache", ".npm", ".cargo", ".rustup", ".local", "node_modules", ".docker":
		return true
	default:
		return false
	}
}

func (s *Server) uploadSnapshotFile(ctx context.Context, uploadPath, filePath, token string, idleTimeout time.Duration) (int64, string, error) {
	target := absoluteControlPlaneURL(s.config.ControlPlaneURL, uploadPath)
	file, err := os.Open(filePath)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	h := sha256.New()
	reader := &countingReader{r: file, hash: h}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, newIdleReader(reader, idleTimeout))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return 0, "", fmt.Errorf("artifact upload failed HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	return reader.n, hex.EncodeToString(h.Sum(nil)), nil
}

func (s *Server) downloadAndExtractTar(ctx context.Context, downloadPath, token string, idleTimeout time.Duration) error {
	res, err := s.snapshotDownload(ctx, downloadPath, token)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	tr := tar.NewReader(newIdleReader(res.Body, idleTimeout))
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		target := filepath.Join(home, filepath.Clean(header.Name))
		if !strings.HasPrefix(target, home) {
			continue
		}
		if header.FileInfo().IsDir() {
			if err := os.MkdirAll(target, header.FileInfo().Mode()); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, header.FileInfo().Mode())
		if err != nil {
			return err
		}
		_, copyErr := io.Copy(f, tr)
		closeErr := f.Close()
		if copyErr != nil {
			return copyErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
}

func (s *Server) downloadAndRestoreWIP(ctx context.Context, downloadPath, token string, idleTimeout time.Duration, workDir, baseCommit string) error {
	res, err := s.snapshotDownload(ctx, downloadPath, token)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	tmp, err := os.CreateTemp("", "sam-session-restore-*.bundle")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	_, copyErr := io.Copy(tmp, newIdleReader(res.Body, idleTimeout))
	closeErr := tmp.Close()
	if copyErr != nil {
		_ = os.Remove(tmpPath)
		return copyErr
	}
	if closeErr != nil {
		_ = os.Remove(tmpPath)
		return closeErr
	}
	defer os.Remove(tmpPath)
	if _, err := runStandaloneGitCommand(ctx, workDir, nil, "fetch", tmpPath, "HEAD:sam-session-restore"); err != nil {
		return err
	}
	if _, err := runStandaloneGitCommand(ctx, workDir, nil, "checkout", "sam-session-restore"); err != nil {
		return err
	}
	if strings.TrimSpace(baseCommit) != "" {
		if _, err := runStandaloneGitCommand(ctx, workDir, nil, "reset", "--soft", baseCommit); err != nil {
			return err
		}
	}
	_, _ = runStandaloneGitCommand(ctx, workDir, nil, "branch", "-D", "sam-session-restore")
	return nil
}

func (s *Server) snapshotDownload(ctx context.Context, downloadPath, token string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, absoluteControlPlaneURL(s.config.ControlPlaneURL, downloadPath), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := s.controlPlaneHTTPClient(0).Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
		_ = res.Body.Close()
		return nil, fmt.Errorf("artifact download failed HTTP %d: %s", res.StatusCode, strings.TrimSpace(string(body)))
	}
	return res, nil
}

func absoluteControlPlaneURL(base, path string) string {
	if strings.HasPrefix(path, "http://") || strings.HasPrefix(path, "https://") {
		return path
	}
	return strings.TrimRight(base, "/") + path
}

type idleReader struct {
	reader      io.Reader
	idleTimeout time.Duration
}

func newIdleReader(reader io.Reader, idleTimeout time.Duration) io.Reader {
	return &idleReader{reader: reader, idleTimeout: idleTimeout}
}

func (r *idleReader) Read(p []byte) (int, error) {
	type result struct {
		n   int
		err error
	}
	ch := make(chan result, 1)
	go func() {
		n, err := r.reader.Read(p)
		ch <- result{n: n, err: err}
	}()
	select {
	case res := <-ch:
		return res.n, res.err
	case <-time.After(r.idleTimeout):
		return 0, fmt.Errorf("snapshot transfer stalled for %s", r.idleTimeout)
	}
}

func choosePositiveInt64(value, fallback int64) int64 {
	if value > 0 {
		return value
	}
	return fallback
}

func choosePositiveDurationMs(value int64, fallback time.Duration) time.Duration {
	if value > 0 {
		return time.Duration(value) * time.Millisecond
	}
	return fallback
}
