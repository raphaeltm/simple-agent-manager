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
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
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
	Available   bool              `json:"available"`
	Reason      string            `json:"reason,omitempty"`
	Status      string            `json:"status,omitempty"`
	Degradation string            `json:"degradation,omitempty"`
	BaseCommit  string            `json:"baseCommit,omitempty"`
	Manifest    *snapshotManifest `json:"manifest,omitempty"`
	Config      struct {
		TransferIdleTimeoutMs int64 `json:"transferIdleTimeoutMs"`
	} `json:"config"`
	Download struct {
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
	AcpSessionID   string                      `json:"acpSessionId,omitempty"`
	AgentType      string                      `json:"agentType,omitempty"`
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

type sessionSnapshotHandlerInput struct {
	workspaceID   string
	sessionID     string
	chatSessionID string
	runtimeName   string
	runtime       *WorkspaceRuntime
	callbackToken string
	agentType     string
}

func (s *Server) sessionSnapshotHandlerInput(w http.ResponseWriter, r *http.Request) (*sessionSnapshotHandlerInput, bool) {
	workspaceID := r.PathValue("workspaceId")
	sessionID := r.PathValue("sessionId")
	if workspaceID == "" || sessionID == "" {
		writeError(w, http.StatusBadRequest, "workspaceId and sessionId are required")
		return nil, false
	}
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return nil, false
	}
	var body struct {
		ChatSessionID          string `json:"chatSessionId"`
		Runtime                string `json:"runtime"`
		AgentType              string `json:"agentType"`
		WorkspaceCallbackToken string `json:"workspaceCallbackToken"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return nil, false
	}
	body.ChatSessionID = strings.TrimSpace(body.ChatSessionID)
	if body.ChatSessionID == "" {
		writeError(w, http.StatusBadRequest, "chatSessionId is required")
		return nil, false
	}
	// A freshly-woken container never ran create-workspace, so its
	// runtime.CallbackToken (the workspace-scoped token used by the message
	// reporter and the snapshot callbacks) is unset. Persist the token the
	// control plane provides on the restore request so chat replies and
	// snapshot callbacks can authenticate after a wake.
	if wsToken := strings.TrimSpace(body.WorkspaceCallbackToken); wsToken != "" {
		s.upsertWorkspaceRuntime(workspaceID, "", "", "", wsToken)
	}
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return nil, false
	}
	callbackToken := s.callbackTokenForWorkspace(workspaceID)
	if callbackToken == "" {
		writeError(w, http.StatusConflict, "workspace callback token unavailable")
		return nil, false
	}
	return &sessionSnapshotHandlerInput{
		workspaceID:   workspaceID,
		sessionID:     sessionID,
		chatSessionID: body.ChatSessionID,
		runtimeName:   body.Runtime,
		runtime:       runtime,
		callbackToken: callbackToken,
		agentType:     strings.TrimSpace(body.AgentType),
	}, true
}

func (s *Server) handleHibernateAgentSession(w http.ResponseWriter, r *http.Request) {
	input, ok := s.sessionSnapshotHandlerInput(w, r)
	if !ok {
		return
	}
	result, err := s.hibernateSessionSnapshot(r.Context(), input.runtime, input.sessionID, input.chatSessionID, input.runtimeName, input.agentType, input.callbackToken)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) handleRestoreAgentSession(w http.ResponseWriter, r *http.Request) {
	input, ok := s.sessionSnapshotHandlerInput(w, r)
	if !ok {
		return
	}
	result, err := s.restoreSessionSnapshot(r.Context(), input.runtime, input.sessionID, input.chatSessionID, input.agentType, input.callbackToken)
	if err != nil {
		_ = s.reportSnapshotRestoreResult(context.Background(), input.workspaceID, input.chatSessionID, "degraded", err.Error(), input.callbackToken)
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":  "degraded",
			"message": "The saved workspace was restored, but the agent context could not be resumed.",
		})
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) hibernateSessionSnapshot(ctx context.Context, runtime *WorkspaceRuntime, sessionID, chatSessionID, runtimeName, agentType, callbackToken string) (map[string]interface{}, error) {
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
	if s.agentSessions != nil {
		if session, exists := s.agentSessions.Get(runtime.ID, sessionID); exists {
			manifest.AcpSessionID = strings.TrimSpace(session.AcpSessionID)
			manifest.AgentType = strings.TrimSpace(session.AgentType)
		}
	}
	if manifest.AcpSessionID != "" && manifest.AgentType == "" {
		manifest.AgentType = strings.TrimSpace(agentType)
	}
	if manifest.AcpSessionID == "" || manifest.AgentType == "" {
		manifest.AcpSessionID = ""
		manifest.AgentType = ""
		manifest.Skipped = append(manifest.Skipped, snapshotSkippedEntry{
			Path:   "agent-context",
			Reason: "resumable agent session identity unavailable",
		})
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

func (s *Server) restoreSessionSnapshot(ctx context.Context, runtime *WorkspaceRuntime, sessionID, chatSessionID, agentType, callbackToken string) (map[string]interface{}, error) {
	restore, err := s.fetchSnapshotRestore(ctx, runtime.ID, chatSessionID, callbackToken)
	if err != nil {
		return nil, err
	}
	if !restore.Available {
		_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "missing", restore.Reason, callbackToken)
		return map[string]interface{}{"status": "transcript-replay", "reason": restore.Reason}, nil
	}
	idleTimeout := choosePositiveDurationMs(restore.Config.TransferIdleTimeoutMs, defaultSnapshotTransferIdleTimeout)
	if restore.Download.Home != "" {
		if err := s.downloadAndExtractTar(ctx, restore.Download.Home, callbackToken, idleTimeout); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "home_failed", err.Error(), callbackToken)
			return nil, err
		}
	}
	// A freshly launched runtime has no repository yet. Provision it after HOME
	// extraction so current runtime assets and credentials overwrite stale
	// snapshot copies, but before applying the Git WIP bundle, which requires a
	// materialized repository.
	var provisionErr error
	if s.config.IsStandaloneMode() {
		provisionErr = s.prepareStandaloneWorkspaceRuntime(ctx, runtime)
	} else {
		_, provisionErr = s.provisionWorkspaceRuntime(ctx, runtime)
	}
	if provisionErr != nil {
		_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "fresh_injection_failed", provisionErr.Error(), callbackToken)
		return nil, provisionErr
	}
	if restore.Download.WIP != "" {
		workDir := standaloneWorkspaceWorkDir(runtime, s.config.WorkspaceDir, s.config.ContainerWorkDir)
		if err := s.downloadAndRestoreWIP(ctx, restore.Download.WIP, callbackToken, idleTimeout, workDir, restore.BaseCommit); err != nil {
			_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "wip_failed", err.Error(), callbackToken)
			return nil, err
		}
	}
	if s.config.IsStandaloneMode() {
		acpSessionID, savedAgentType, identityErr := snapshotHarnessResumeIdentity(restore.Manifest, sessionID, agentType)
		if identityErr != nil {
			return nil, identityErr
		}
		// Prime the per-workspace message reporter before the agent starts.
		// handleCreateAgentSession does this on the normal path; the restore path
		// skipped it, so the restored agent's output had no reporter to enqueue
		// to and chat replies were silently dropped after a wake.
		s.primeRestoredMessageReporter(runtime, chatSessionID)
		session, _, createErr := s.agentSessions.Create(runtime.ID, sessionID, "Restored session", "restore:"+sessionID)
		if createErr != nil {
			return nil, fmt.Errorf("recreate restored agent session: %w", createErr)
		}
		if updateErr := s.agentSessions.UpdateAcpSessionID(runtime.ID, sessionID, acpSessionID, savedAgentType); updateErr != nil {
			return nil, fmt.Errorf("hydrate restored agent session: %w", updateErr)
		}
		session, exists := s.agentSessions.Get(runtime.ID, sessionID)
		if !exists {
			return nil, fmt.Errorf("restored agent session is unavailable")
		}
		hostKey := runtime.ID + ":" + sessionID
		host := s.getOrCreateSessionHost(hostKey, runtime.ID, sessionID, session, runtime, "")
		if restoreErr := host.RestoreAgent(ctx, savedAgentType); restoreErr != nil {
			return nil, fmt.Errorf("resume saved agent context: %w", restoreErr)
		}
		if host.Status() != acp.HostReady {
			return nil, fmt.Errorf("restored agent failed to become ready: %s", host.Status())
		}
	} else if session, exists := s.agentSessions.Get(runtime.ID, sessionID); exists {
		hostKey := runtime.ID + ":" + sessionID
		_ = s.getOrCreateSessionHost(hostKey, runtime.ID, sessionID, session, runtime, "")
	}
	_ = s.reportSnapshotRestoreResult(ctx, runtime.ID, chatSessionID, "restored", "", callbackToken)
	return map[string]interface{}{"status": "restored", "degradation": restore.Degradation}, nil
}

func snapshotHarnessResumeIdentity(manifest *snapshotManifest, sessionID, requestedAgentType string) (string, string, error) {
	if manifest == nil {
		return "", "", fmt.Errorf("snapshot manifest is unavailable")
	}
	savedSessionID := strings.TrimSpace(manifest.AgentSessionID)
	if savedSessionID != "" && savedSessionID != strings.TrimSpace(sessionID) {
		return "", "", fmt.Errorf("snapshot agent session does not match restore target")
	}
	acpSessionID := strings.TrimSpace(manifest.AcpSessionID)
	savedAgentType := strings.TrimSpace(manifest.AgentType)
	if acpSessionID == "" || savedAgentType == "" {
		return "", "", fmt.Errorf("snapshot does not contain resumable agent context")
	}
	requestedAgentType = strings.TrimSpace(requestedAgentType)
	if requestedAgentType == "" {
		return "", "", fmt.Errorf("agent type is required to restore a standalone session")
	}
	if requestedAgentType != savedAgentType {
		return "", "", fmt.Errorf("snapshot agent type does not match requested agent")
	}
	return acpSessionID, savedAgentType, nil
}

// primeRestoredMessageReporter ensures the per-workspace message reporter exists
// and is bound to the restored chat session before the agent starts producing
// output. handleCreateAgentSession does this on the normal path; the restore
// path must replicate it or the restored agent's replies are never enqueued and
// are silently dropped after a wake.
func (s *Server) primeRestoredMessageReporter(runtime *WorkspaceRuntime, chatSessionID string) {
	if runtime == nil {
		return
	}
	chatSessionID = strings.TrimSpace(chatSessionID)
	projectID := strings.TrimSpace(runtime.ProjectID)
	if projectID == "" {
		projectID = strings.TrimSpace(s.config.ProjectID)
	}
	if projectID == "" || chatSessionID == "" {
		// Without a project + chat session the reporter cannot be created, so
		// the restored agent's output would be silently dropped. Log loudly so
		// this failure mode is diagnosable instead of invisible.
		slog.Warn("Restored session message reporter not primed: missing project or chat session",
			"workspaceId", runtime.ID, "hasProjectID", projectID != "", "hasChatSessionID", chatSessionID != "")
		return
	}
	s.workspaceMu.Lock()
	if rt, ok := s.workspaces[runtime.ID]; ok && strings.TrimSpace(rt.ProjectID) == "" {
		rt.ProjectID = projectID
	}
	s.workspaceMu.Unlock()
	if reporter := s.getOrCreateReporter(runtime.ID, projectID, chatSessionID); reporter != nil {
		reporter.SetSessionID(chatSessionID)
	}
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

func (s *Server) uploadSnapshotFile(ctx context.Context, uploadPath, filePath, token string, idleTimeout time.Duration) (int64, string, error) {
	target := absoluteControlPlaneURL(s.config.ControlPlaneURL, uploadPath)
	file, err := os.Open(filePath)
	if err != nil {
		return 0, "", err
	}
	defer file.Close()
	fileInfo, err := file.Stat()
	if err != nil {
		return 0, "", err
	}
	h := sha256.New()
	reader := &countingReader{r: file, hash: h}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, target, newIdleReader(reader, idleTimeout))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.ContentLength = fileInfo.Size()
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
	home = filepath.Clean(home)
	tr := tar.NewReader(newIdleReader(res.Body, idleTimeout))
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		cleanName := filepath.Clean(header.Name)
		if filepath.IsAbs(cleanName) || cleanName == "." || cleanName == ".." || strings.HasPrefix(cleanName, ".."+string(filepath.Separator)) {
			continue
		}
		target := filepath.Join(home, cleanName)
		relTarget, relErr := filepath.Rel(home, target)
		if relErr != nil || relTarget == ".." || strings.HasPrefix(relTarget, ".."+string(filepath.Separator)) {
			continue
		}
		if err := rejectSymlinkPath(home, target); err != nil {
			return err
		}
		if header.Typeflag != tar.TypeDir && header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeRegA {
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
	heads, err := runStandaloneGitCommand(ctx, workDir, nil, "bundle", "list-heads", tmpPath)
	if err != nil {
		return fmt.Errorf("list snapshot bundle heads: %w: %s", err, heads)
	}
	bundleRefs := make(map[string]string)
	for _, line := range strings.Split(strings.TrimSpace(heads), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			bundleRefs[fields[1]] = fields[0]
		}
	}
	if len(bundleRefs) == 0 {
		return fmt.Errorf("snapshot bundle has no restorable ref")
	}
	worktreeRef, worktreeCommit := snapshotBundleRef(bundleRefs, "/worktree")
	indexRef, indexCommit := snapshotBundleRef(bundleRefs, "/index")
	if worktreeRef != "" && indexRef != "" {
		if output, err := runStandaloneGitCommand(ctx, workDir, nil, "fetch", tmpPath, worktreeRef, indexRef); err != nil {
			return fmt.Errorf("fetch snapshot bundle: %w: %s", err, output)
		}
		if output, err := runStandaloneGitCommand(ctx, workDir, nil, "read-tree", "--reset", "-u", worktreeCommit); err != nil {
			return fmt.Errorf("materialize snapshot worktree: %w: %s", err, output)
		}
		if strings.TrimSpace(baseCommit) != "" {
			if output, err := runStandaloneGitCommand(ctx, workDir, nil, "reset", "--soft", baseCommit); err != nil {
				return fmt.Errorf("restore snapshot base commit: %w: %s", err, output)
			}
		}
		if output, err := runStandaloneGitCommand(ctx, workDir, nil, "read-tree", indexCommit); err != nil {
			return fmt.Errorf("restore snapshot index: %w: %s", err, output)
		}
		return nil
	}

	// Version 1 bundles written before index preservation contained a single
	// synthetic commit. Keep restoring them for compatibility; their original
	// staged/unstaged split was not encoded and therefore cannot be recovered.
	var legacyRef string
	for ref := range bundleRefs {
		legacyRef = ref
		break
	}
	if output, err := runStandaloneGitCommand(ctx, workDir, nil, "fetch", tmpPath, legacyRef); err != nil {
		return fmt.Errorf("fetch snapshot bundle: %w: %s", err, output)
	}
	if output, err := runStandaloneGitCommand(ctx, workDir, nil, "read-tree", "--reset", "-u", "FETCH_HEAD"); err != nil {
		return fmt.Errorf("materialize snapshot tree: %w: %s", err, output)
	}
	if strings.TrimSpace(baseCommit) != "" {
		if output, err := runStandaloneGitCommand(ctx, workDir, nil, "reset", "--mixed", baseCommit); err != nil {
			return fmt.Errorf("restore snapshot base commit: %w: %s", err, output)
		}
	}
	return nil
}

func snapshotBundleRef(refs map[string]string, suffix string) (string, string) {
	for ref, commit := range refs {
		if strings.HasSuffix(ref, suffix) {
			return ref, commit
		}
	}
	return "", ""
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
