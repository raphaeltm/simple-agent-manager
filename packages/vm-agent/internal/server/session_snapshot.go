package server

import (
	"archive/tar"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	defaultSnapshotTotalBudgetBytes    int64         = 100 * 1024 * 1024
	defaultSnapshotEntryThresholdBytes int64         = 50 * 1024 * 1024
	defaultSnapshotTransferIdleTimeout time.Duration = 30 * time.Second
	defaultSnapshotInventoryMaxBytes   int64         = 32 * 1024 * 1024
	defaultSnapshotMaxArchiveEntries                 = 100_000
)

type snapshotPrepareResponse struct {
	ExpiresAt  string `json:"expiresAt"`
	Generation string `json:"generation"`
	Config     struct {
		TotalBudgetBytes      int64 `json:"totalBudgetBytes"`
		EntryThresholdBytes   int64 `json:"entryThresholdBytes"`
		TransferIdleTimeoutMs int64 `json:"transferIdleTimeoutMs"`
		JSONBodyMaxBytes      int64 `json:"jsonBodyMaxBytes"`
	} `json:"config"`
	Upload struct {
		Home string `json:"home"`
		WIP  string `json:"wip"`
	} `json:"upload"`
	DirectUpload struct {
		Home string `json:"home"`
		WIP  string `json:"wip"`
	} `json:"directUpload"`
}

type snapshotRestoreResponse struct {
	Available   bool              `json:"available"`
	Reason      string            `json:"reason,omitempty"`
	Status      string            `json:"status,omitempty"`
	Degradation string            `json:"degradation,omitempty"`
	BaseCommit  string            `json:"baseCommit,omitempty"`
	Manifest    *snapshotManifest `json:"manifest,omitempty"`
	Config      struct {
		TotalBudgetBytes      int64 `json:"totalBudgetBytes"`
		EntryThresholdBytes   int64 `json:"entryThresholdBytes"`
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
	Git            *snapshotGitMetadata        `json:"git,omitempty"`
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

type sessionSnapshotHandlerInput struct {
	workspaceID            string
	sessionID              string
	chatSessionID          string
	runtimeName            string
	runtime                *WorkspaceRuntime
	callbackToken          string
	agentType              string
	background             bool
	workspaceCallbackToken string
	acpSessionID           string
	containerTarget        *containerSnapshotTarget
}

func (s *Server) sessionSnapshotHandlerInput(w http.ResponseWriter, r *http.Request, restoring bool) (*sessionSnapshotHandlerInput, bool) {
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
		Background             bool   `json:"background"`
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
	// Validate routing before accepting callback credentials or touching files.
	if restoring {
		if err := s.initializeStandaloneRestoreSession(workspaceID, sessionID, body.ChatSessionID, body.Runtime); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return nil, false
		}
		if err := s.validateSessionRestoreIdentity(workspaceID, sessionID, body.ChatSessionID, strings.TrimSpace(body.AgentType)); err != nil {
			writeError(w, http.StatusConflict, err.Error())
			return nil, false
		}
	}
	// A freshly-woken container never ran create-workspace, so its
	// runtime.CallbackToken (the workspace-scoped token used by the message
	// reporter and the snapshot callbacks) is unset. Persist the token the
	// control plane provides on the restore request so chat replies and
	// snapshot callbacks can authenticate after a wake.
	if wsToken := strings.TrimSpace(body.WorkspaceCallbackToken); wsToken != "" && !restoring {
		s.upsertWorkspaceRuntime(workspaceID, "", "", "", wsToken, workspaceRuntimeOpts{ChatSessionID: body.ChatSessionID})
	}
	runtime, ok := s.getWorkspaceRuntime(workspaceID)
	if !ok {
		writeError(w, http.StatusNotFound, "workspace not found")
		return nil, false
	}
	if !restoring {
		s.recordWorkspaceChatSessionID(workspaceID, body.ChatSessionID)
	}
	callbackToken := s.callbackTokenForWorkspace(workspaceID)
	if restoring && strings.TrimSpace(body.WorkspaceCallbackToken) != "" {
		callbackToken = strings.TrimSpace(body.WorkspaceCallbackToken)
	}
	if callbackToken == "" {
		writeError(w, http.StatusConflict, "workspace callback token unavailable")
		return nil, false
	}
	acpSessionID := ""
	if s.agentSessions != nil {
		if session, exists := s.agentSessions.Get(workspaceID, sessionID); exists {
			acpSessionID = strings.TrimSpace(session.AcpSessionID)
		}
	}
	return &sessionSnapshotHandlerInput{
		workspaceID:            workspaceID,
		sessionID:              sessionID,
		chatSessionID:          body.ChatSessionID,
		runtimeName:            body.Runtime,
		runtime:                runtime,
		callbackToken:          callbackToken,
		agentType:              strings.TrimSpace(body.AgentType),
		background:             body.Background,
		workspaceCallbackToken: strings.TrimSpace(body.WorkspaceCallbackToken),
		acpSessionID:           acpSessionID,
	}, true
}

func (s *Server) handleHibernateAgentSession(w http.ResponseWriter, r *http.Request) {
	input, ok := s.sessionSnapshotHandlerInput(w, r, false)
	if !ok {
		return
	}
	if input.background {
		accepted := s.startBackgroundSessionSnapshot(input)
		writeJSON(w, http.StatusAccepted, map[string]interface{}{
			"status":   "pending",
			"accepted": accepted,
		})
		return
	}
	result, err := s.captureSessionSnapshot(r.Context(), input)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) hibernateSessionSnapshot(ctx context.Context, input *sessionSnapshotHandlerInput) (map[string]interface{}, error) {
	runtime := input.runtime
	sessionID, chatSessionID := input.sessionID, input.chatSessionID
	runtimeName, callbackToken := input.runtimeName, input.callbackToken

	prepare, err := s.prepareSnapshot(ctx, runtime.ID, sessionID, chatSessionID, runtimeName, callbackToken)
	if err != nil {
		return nil, err
	}
	progress := newSnapshotProgressReporter(s, runtime.ID, chatSessionID, prepare.Generation, callbackToken)
	progress.Report(ctx, "prepared")
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
	s.populateSnapshotHarnessIdentity(&manifest, runtime.ID, sessionID, input.acpSessionID, input.agentType)
	agentContextSkipped := false
	if manifest.AcpSessionID == "" || manifest.AgentType == "" {
		manifest.AcpSessionID = ""
		manifest.AgentType = ""
		agentContextSkipped = true
		manifest.Skipped = append(manifest.Skipped, snapshotSkippedEntry{
			Path:   "agent-context",
			Reason: "resumable agent session identity unavailable",
		})
	}
	workDir := standaloneWorkspaceWorkDir(runtime, s.config.WorkspaceDir, s.config.ContainerWorkDir)
	var snapshotTarget *containerSnapshotTarget
	if !s.config.IsStandaloneMode() {
		snapshotTarget = input.containerTarget
		if snapshotTarget == nil {
			snapshotTarget, err = s.resolveContainerSnapshotTarget(ctx, runtime)
			if err != nil {
				return nil, newSnapshotResolveError(prepare.Generation, err)
			}
		}
		workDir = snapshotTarget.workDir
	}
	capture := snapshotArtifactCapture{server: s, target: snapshotTarget, workDir: workDir, token: callbackToken, prepare: prepare, threshold: entryThreshold, budget: totalBudget, idleTimeout: idleTimeout, progress: progress, manifest: &manifest}
	wipCaptureFailed := capture.captureWIP(ctx)
	homeCaptureFailed := capture.captureHome(ctx)
	if homeCaptureFailed && wipCaptureFailed {
		manifest.Degradation = "transcript-only"
		manifest.Status = "degraded"
	} else if homeCaptureFailed {
		manifest.Degradation = "home-skipped"
		manifest.Status = "degraded"
	} else if wipCaptureFailed {
		manifest.Degradation = "wip-skipped"
		manifest.Status = "degraded"
	}
	if agentContextSkipped && manifest.Degradation == "none" {
		// Both artifacts were captured but the snapshot has no resumable harness
		// identity. Status flips to degraded below; a "none" degradation label
		// alongside that would be misleading, so record a distinct reason. A more
		// severe artifact-based degradation, if set above, takes precedence.
		manifest.Degradation = "agent-context-skipped"
	}
	if len(manifest.Skipped) > 0 && manifest.Degradation == "none" {
		manifest.Degradation = "entries-skipped"
	}
	if len(manifest.Skipped) > 0 && manifest.Status == "available" {
		manifest.Status = "degraded"
	}
	manifest.Skipped = boundSnapshotSkippedEntries(manifest.Skipped, snapshotSkippedEntriesBudget(prepare))
	err = s.completeSnapshot(ctx, runtime.ID, sessionID, chatSessionID, runtimeName, prepare.Generation, callbackToken, manifest)
	if err != nil {
		return nil, &sessionSnapshotCaptureError{generation: prepare.Generation, err: err}
	}
	return map[string]interface{}{"status": manifest.Status, "degradation": manifest.Degradation, "skipped": manifest.Skipped}, nil
}

func (s *Server) downloadAndExtractTar(ctx context.Context, downloadPath, token string, idleTimeout time.Duration) error {
	return s.downloadAndExtractSessionStateTar(ctx, downloadPath, token, idleTimeout, defaultSnapshotEntryThresholdBytes, defaultSnapshotTotalBudgetBytes)
}

func (s *Server) downloadAndExtractSessionStateTar(ctx context.Context, downloadPath, token string, idleTimeout time.Duration, entryThreshold, totalBudget int64) error {
	path, err := s.downloadSnapshotArtifactToTemp(ctx, downloadPath, token, idleTimeout, "sam-session-restore-home-*.tar", totalBudget)
	if err != nil {
		return err
	}
	defer os.Remove(path)
	// Security boundary: validate the complete immutable temp archive before the
	// first filesystem mutation. The validator rejects absolute/traversing and
	// duplicate paths, links, special entries, file/child conflicts, excluded
	// credential paths, and entries outside the configured size budgets.
	if _, err := validateSnapshotHomeTar(path, entryThreshold, totalBudget); err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	home = filepath.Clean(home)
	candidates, err := externalSnapshotRootCandidates(home, os.Getenv)
	if err != nil {
		return err
	}
	destinations := map[string]string{"": home}
	for _, candidate := range candidates {
		if candidate.path != "" {
			destinations[candidate.logicalName] = candidate.path
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	tr := tar.NewReader(file)
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		cleanName := filepath.ToSlash(filepath.Clean(header.Name))
		logicalName, relativeName, external, locationErr := snapshotArchiveLocation(cleanName)
		if locationErr != nil {
			return locationErr
		}
		destination, exists := destinations[logicalName]
		if !external {
			relativeName = cleanName
		}
		if !exists {
			return fmt.Errorf("restored runtime does not define %s state destination", logicalName)
		}
		if relativeName == "." {
			continue
		}
		if err := ensureSafeLocalSnapshotDestination(destination); err != nil {
			return err
		}
		target := filepath.Join(destination, filepath.FromSlash(relativeName))
		if err := rejectSymlinkPath(destination, target); err != nil {
			return err
		}
		if header.FileInfo().IsDir() {
			if err := os.MkdirAll(target, header.FileInfo().Mode().Perm()); err != nil { // NOSONAR gosecurity:S6096 -- the full archive and this root-confined, non-symlink target are validated above
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil { // NOSONAR gosecurity:S6096 -- target passed archive validation, root confinement, and symlink rejection above
			return err
		}
		f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, header.FileInfo().Mode().Perm()) // NOSONAR gosecurity:S6096 -- target passed archive validation, root confinement, and symlink rejection above
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

func ensureSafeLocalSnapshotDestination(destination string) error {
	destination = filepath.Clean(destination)
	if !filepath.IsAbs(destination) || destination == string(filepath.Separator) {
		return fmt.Errorf("unsafe local snapshot destination %q", destination)
	}
	if err := rejectSymlinkPath(string(filepath.Separator), destination); err != nil {
		return err
	}
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return err
	}
	return rejectSymlinkPath(string(filepath.Separator), destination)
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
