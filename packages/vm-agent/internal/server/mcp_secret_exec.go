package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/acp"
	"github.com/workspace/vm-agent/internal/persistence"
	"github.com/workspace/vm-agent/internal/secretexec"
)

const (
	defaultSecretExecTimeoutMs        = 600000
	defaultSecretExecMaxTimeoutMs     = 3600000
	defaultSecretExecOutputBytes      = 65536
	defaultSecretExecMaxActive        = 8
	defaultSecretExecBodyBytes        = 1048576
	defaultSecretExecGraceMs          = 1000
	defaultSecretExecTransportGraceMs = 2000
	secretExecKind                    = "secret-exec"
)

var secretExecEnvKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
var secretExecJobID = regexp.MustCompile(`^sx-[a-f0-9]{64}$`)

type secretExecRequest struct {
	JobID       string            `json:"jobId"`
	SessionID   string            `json:"agentSessionId"`
	UserID      string            `json:"userId"`
	ProjectID   string            `json:"projectId"`
	TaskID      string            `json:"taskId"`
	Fingerprint string            `json:"fingerprint"`
	Argv        []string          `json:"argv"`
	Command     *string           `json:"command"`
	Shell       string            `json:"shell"`
	Cwd         string            `json:"cwd"`
	Env         map[string]string `json:"env"`
	SecretNames []string          `json:"secretNames"`
	ManagedEnv  []secretExecEnv   `json:"managedEnv"`
	TimeoutMs   int               `json:"timeoutMs"`
}
type secretExecEnv struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	IsSecret bool   `json:"isSecret"`
}
type secretExecMetadata struct {
	ContainerID        string   `json:"containerId"`
	User               string   `json:"user"`
	Cwd                string   `json:"cwd"`
	EnvironmentMode    string   `json:"environmentMode"`
	SecretNames        []string `json:"secretNames,omitempty"`
	ActorUserID        string   `json:"actorUserId,omitempty"`
	WorkspaceID        string   `json:"workspaceId"`
	AgentSessionID     string   `json:"agentSessionId"`
	ProjectID          string   `json:"projectId,omitempty"`
	TaskID             string   `json:"taskId,omitempty"`
	CommandMode        string   `json:"commandMode"`
	CommandFingerprint string   `json:"commandFingerprint"`
	StartedAt          string   `json:"startedAt"`
	CompletedAt        string   `json:"completedAt,omitempty"`
}
type secretExecSnapshot struct {
	JobID  string `json:"jobId"`
	Status string `json:"status"`
	secretexec.Result
	Execution secretExecMetadata `json:"execution"`
}
type secretExecState struct {
	Snapshot           secretExecSnapshot
	Fingerprint        string
	SessionID          string
	WorkspaceID        string
	Cancel             context.CancelFunc
	Done               chan struct{}
	PersistencePending bool
	ReleaseActivity    func()
}

func secretExecLimit(name string, fallback int) int {
	if n, e := strconv.Atoi(os.Getenv(name)); e == nil && n > 0 {
		return n
	}
	return fallback
}
func secretExecScope(workspace, session string) string {
	sum := sha256.Sum256([]byte(workspace + "\x00" + session))
	return hex.EncodeToString(sum[:])
}

func (s *Server) handleMcpSecretExecStart(w http.ResponseWriter, r *http.Request) {
	workspaceID := r.PathValue("workspaceId")
	if !s.requireNodeManagementAuth(w, r, workspaceID) {
		return
	}
	// Audit caller identity comes from the verified management token, not the body.
	claims, claimErr := s.jwtValidator.ValidateNodeManagementToken(strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")), workspaceID)
	if claimErr != nil {
		writeError(w, 401, "Invalid management identity")
		return
	}
	if s.store == nil {
		writeError(w, 503, "Job persistence unavailable")
		return
	}
	var req secretExecRequest
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, int64(secretExecLimit("SECRET_EXEC_BODY_BYTES", defaultSecretExecBodyBytes))))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		writeError(w, 400, "Invalid execution request")
		return
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		writeError(w, 400, "Execution request must contain one JSON object")
		return
	}
	if err := validateSecretExecRequest(&req); err != nil {
		writeError(w, 400, err.Error())
		return
	}
	containerID, user, cwd, err := s.resolveSecretExecContext(r.Context(), workspaceID, req.SessionID)
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	if req.Cwd != "" {
		cwd = req.Cwd
	}
	if !filepath.IsAbs(cwd) || strings.ContainsRune(cwd, 0) {
		writeError(w, 400, "cwd must be absolute")
		return
	}
	values := make(map[string]string)
	mode := "placeholder"
	if containerID != "" {
		for _, entry := range acp.ReadContainerEnvFiles(r.Context(), containerID) {
			key, value, ok := strings.Cut(entry, "=")
			if ok {
				values[key] = value
			}
		}
	}
	selected := make(map[string]bool)
	for _, name := range req.SecretNames {
		selected[name] = true
	}
	secrets := []string{}
	for _, item := range req.ManagedEnv {
		if !secretExecEnvKey.MatchString(item.Key) || strings.ContainsRune(item.Value, 0) {
			writeError(w, 400, "Invalid managed environment")
			return
		}
		if item.IsSecret {
			placeholder := "__SAM_SECRET_REQUIRES_EXEC_WITH_SECRETS__" + item.Key + "__"
			if containerID != "" && values[item.Key] != placeholder {
				mode = "legacy"
			}
			if selected[item.Key] {
				secrets = append(secrets, item.Value)
				delete(selected, item.Key)
			} else if item.Value != placeholder {
				writeError(w, 400, "Unselected secret must be a placeholder")
				return
			}
		}
		values[item.Key] = item.Value
	}
	if len(selected) > 0 {
		writeError(w, 400, "Selected secret unavailable")
		return
	}
	for key, value := range req.Env {
		for _, item := range req.ManagedEnv {
			if item.Key == key && item.IsSecret {
				writeError(w, 400, "Secret environment cannot be overridden")
				return
			}
		}
		values[key] = value
	}
	argv := req.Argv
	if req.Command != nil {
		if req.Shell == "bash" {
			argv = []string{"bash", "--noprofile", "--norc", "-c", *req.Command}
		} else {
			argv = []string{"sh", "-c", *req.Command}
		}
	}
	scope := secretExecScope(workspaceID, req.SessionID)
	s.secretExecMu.Lock()
	if s.secretExecJobs == nil {
		s.secretExecJobs = make(map[string]*secretExecState)
	}
	existing, err := s.store.GetJob(req.JobID)
	if err != nil {
		s.secretExecMu.Unlock()
		writeError(w, 503, "Job persistence unavailable")
		return
	}
	if existing != nil {
		s.secretExecMu.Unlock()
		if existing.Kind != secretExecKind || existing.ScopeID != scope || existing.CurrentStep != req.Fingerprint {
			writeError(w, 409, "Job key belongs to a different request")
			return
		}
		s.writeSecretExecSnapshot(w, existing, req.JobID)
		return
	}
	if len(s.secretExecJobs) >= secretExecLimit("SECRET_EXEC_MAX_ACTIVE", defaultSecretExecMaxActive) {
		s.secretExecMu.Unlock()
		writeError(w, 429, "Execution capacity reached")
		return
	}
	commandMode := "argv"
	if req.Command != nil {
		commandMode = req.Shell
	}
	snapshot := secretExecSnapshot{JobID: req.JobID, Status: "running", Result: secretexec.Result{ExitCode: -1}, Execution: secretExecMetadata{ContainerID: containerID, User: user, Cwd: cwd, EnvironmentMode: mode, SecretNames: append([]string(nil), req.SecretNames...), ActorUserID: claims.Subject, WorkspaceID: workspaceID, AgentSessionID: req.SessionID, ProjectID: req.ProjectID, TaskID: req.TaskID, CommandMode: commandMode, CommandFingerprint: req.Fingerprint, StartedAt: time.Now().UTC().Format(time.RFC3339Nano)}}
	// Register job-owned activity while fenced by the job mutex; explicit stop
	// removes/stops the host and then cancels any inserted job.
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(req.TimeoutMs)*time.Millisecond)
	deadline, _ := ctx.Deadline()
	releaseActivity := func() {}
	s.sessionHostMu.Lock()
	owner := s.sessionHosts[workspaceID+":"+req.SessionID]
	if owner != nil && owner.TrackSecretExecution(req.JobID, deadline, cancel) {
		releaseActivity = func() { owner.EndSecretExecution(req.JobID) }
	} else if s.secretExecContextResolver == nil {
		s.sessionHostMu.Unlock()
		cancel()
		s.secretExecMu.Unlock()
		writeError(w, 409, "Agent session stopped before job acceptance")
		return
	}
	s.sessionHostMu.Unlock()
	raw, _ := json.Marshal(snapshot)
	if err := s.store.UpsertJob(persistence.JobRecord{ID: req.JobID, Kind: secretExecKind, ScopeID: scope, Status: "running", CurrentStep: req.Fingerprint, ResultJSON: string(raw)}); err != nil {
		cancel()
		releaseActivity()
		s.secretExecMu.Unlock()
		writeError(w, 503, "Job persistence unavailable")
		return
	}
	// This bounded job owns its lifetime after acceptance; never use r.Context().
	state := &secretExecState{Snapshot: snapshot, Fingerprint: req.Fingerprint, SessionID: req.SessionID, WorkspaceID: workspaceID, Cancel: cancel, Done: make(chan struct{}), ReleaseActivity: releaseActivity}
	s.secretExecJobs[req.JobID] = state
	s.secretExecMu.Unlock()
	go s.runSecretExec(ctx, state, argv, values, secrets)
	writeJSON(w, http.StatusAccepted, snapshot)
}
func unsupportedSecretExecEnvName(name string) bool {
	switch name {
	case "ENV", "BASH_ENV", "UID", "EUID", "PPID", "SHELLOPTS", "BASHOPTS", "BASH_VERSINFO":
		return true
	}
	return false
}

func validateSecretExecRequest(req *secretExecRequest) error {
	for _, item := range req.ManagedEnv {
		if unsupportedSecretExecEnvName(item.Key) {
			return fmt.Errorf("Unsupported managed shell environment variable name")
		}
	}
	if !secretExecJobID.MatchString(req.JobID) || req.SessionID == "" || len(req.Fingerprint) != 64 {
		return fmt.Errorf("Invalid job identity")
	}
	if (len(req.Argv) > 0) == (req.Command != nil) {
		return fmt.Errorf("Choose exactly argv or command with shell")
	}
	if req.Command != nil && req.Shell != "bash" && req.Shell != "sh" {
		return fmt.Errorf("Explicit bash or sh is required")
	}
	if req.Command == nil && req.Shell != "" {
		return fmt.Errorf("shell requires command")
	}
	for _, arg := range req.Argv {
		if strings.ContainsRune(arg, 0) {
			return fmt.Errorf("Arguments cannot contain NUL")
		}
	}
	if req.Command != nil && strings.ContainsRune(*req.Command, 0) {
		return fmt.Errorf("Command cannot contain NUL")
	}
	for key, value := range req.Env {
		if unsupportedSecretExecEnvName(key) {
			return fmt.Errorf("Unsupported shell environment variable name")
		}
		if !secretExecEnvKey.MatchString(key) || strings.ContainsRune(value, 0) {
			return fmt.Errorf("Invalid environment override")
		}
	}
	for _, name := range req.SecretNames {
		if unsupportedSecretExecEnvName(name) {
			return fmt.Errorf("Unsupported shell environment variable name")
		}
	}
	if req.TimeoutMs == 0 {
		req.TimeoutMs = secretExecLimit("SECRET_EXEC_TIMEOUT_MS", defaultSecretExecTimeoutMs)
	}
	if req.TimeoutMs < 1 || req.TimeoutMs > secretExecLimit("SECRET_EXEC_MAX_TIMEOUT_MS", defaultSecretExecMaxTimeoutMs) {
		return fmt.Errorf("Timeout exceeds configured bounds")
	}
	return nil
}
func (s *Server) runSecretExec(ctx context.Context, state *secretExecState, argv []string, values map[string]string, secrets []string) {
	defer close(state.Done)
	if state.ReleaseActivity != nil {
		defer state.ReleaseActivity()
	}
	grace := time.Duration(secretExecLimit("SECRET_EXEC_GRACE_MS", defaultSecretExecGraceMs)) * time.Millisecond
	metadata := state.Snapshot.Execution
	args := secretexec.SupervisorArgs(grace)
	var cmd *exec.Cmd
	if metadata.ContainerID == "" {
		cmd = exec.Command(args[0], args[1:]...)
		cmd.Dir = metadata.Cwd
		if s.secretExecBaseEnv != nil {
			cmd.Env = standaloneWorkspaceExecEnv(state.WorkspaceID, s.secretExecBaseEnv, nil)
		} else {
			cmd.Env = standaloneWorkspaceExecEnv(state.WorkspaceID, os.Environ(), nil)
		}
	} else {
		dockerArgs := []string{"exec", "-i"}
		if metadata.User != "" {
			dockerArgs = append(dockerArgs, "-u", metadata.User)
		}
		dockerArgs = append(dockerArgs, "-w", metadata.Cwd, metadata.ContainerID)
		dockerArgs = append(dockerArgs, args...)
		cmd = exec.Command(dockerBinaryPath, dockerArgs...)
	}
	result := secretexec.Run(ctx, cmd, secretexec.Input{Argv: argv, Env: values, Secrets: secrets, OutputLimit: secretExecLimit("SECRET_EXEC_OUTPUT_BYTES", defaultSecretExecOutputBytes), GracePeriod: grace, TransportGracePeriod: time.Duration(secretExecLimit("SECRET_EXEC_TRANSPORT_GRACE_MS", defaultSecretExecTransportGraceMs)) * time.Millisecond})
	status := "completed"
	if result.ExitCode != 0 {
		status = "failed"
	}
	if ctx.Err() == context.Canceled {
		status = "cancelled"
	}
	if result.TimedOut {
		status = "timed_out"
	}
	state.Cancel()
	s.secretExecMu.Lock()
	defer s.secretExecMu.Unlock()
	state.Snapshot.Result = result
	state.Snapshot.Status = status
	state.Snapshot.Execution.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	raw, _ := json.Marshal(state.Snapshot)
	// Preserve fingerprint in CurrentStep for durable retry conflict detection.
	if err := s.store.CompleteJob(state.Snapshot.JobID, status, state.Fingerprint, "", string(raw)); err == nil {
		delete(s.secretExecJobs, state.Snapshot.JobID)
	} else {
		state.PersistencePending = true
	}
}
func (s *Server) handleMcpSecretExecStatus(w http.ResponseWriter, r *http.Request) {
	s.secretExecStatus(w, r, false)
}
func (s *Server) handleMcpSecretExecCancel(w http.ResponseWriter, r *http.Request) {
	s.secretExecStatus(w, r, true)
}
func (s *Server) secretExecStatus(w http.ResponseWriter, r *http.Request, cancel bool) {
	workspace := r.PathValue("workspaceId")
	if !s.requireNodeManagementAuth(w, r, workspace) {
		return
	}
	id := r.PathValue("jobId")
	session := r.URL.Query().Get("agentSessionId")
	if !secretExecJobID.MatchString(id) || session == "" || s.store == nil {
		writeError(w, 400, "Invalid job identity")
		return
	}
	s.secretExecMu.Lock()
	defer s.secretExecMu.Unlock()
	job, err := s.store.GetJob(id)
	if err != nil {
		writeError(w, 503, "Job persistence unavailable")
		return
	}
	if job == nil || job.Kind != secretExecKind || job.ScopeID != secretExecScope(workspace, session) {
		writeError(w, 404, "Job not found")
		return
	}
	if state := s.secretExecJobs[id]; state != nil {
		if state.PersistencePending {
			raw, _ := json.Marshal(state.Snapshot)
			if err := s.store.CompleteJob(id, state.Snapshot.Status, state.Fingerprint, "", string(raw)); err != nil {
				writeError(w, 503, "Job persistence unavailable")
				return
			}
			delete(s.secretExecJobs, id)
		}
		if cancel {
			state.Cancel()
		}
		writeJSON(w, 200, state.Snapshot)
		return
	}
	s.writeSecretExecSnapshot(w, job, id)
}
func (s *Server) writeSecretExecSnapshot(w http.ResponseWriter, job *persistence.JobRecord, id string) {
	var snapshot secretExecSnapshot
	if err := json.Unmarshal([]byte(job.ResultJSON), &snapshot); err != nil {
		writeError(w, 503, "Job result unavailable")
		return
	}
	snapshot.JobID = id
	snapshot.Status = job.Status
	writeJSON(w, 200, snapshot)
}

// Shutdown owns cancellation before the persistence store is closed.
func (s *Server) stopSecretExecutions(ctx context.Context) {
	s.secretExecMu.Lock()
	jobs := make([]*secretExecState, 0, len(s.secretExecJobs))
	for _, state := range s.secretExecJobs {
		state.Cancel()
		jobs = append(jobs, state)
	}
	s.secretExecMu.Unlock()
	for _, state := range jobs {
		select {
		case <-state.Done:
		case <-ctx.Done():
			return
		}
	}
}

func (s *Server) resolveSecretExecContext(ctx context.Context, workspaceID, sessionID string) (string, string, string, error) {
	if s.secretExecContextResolver != nil {
		return s.secretExecContextResolver(ctx, workspaceID, sessionID)
	}
	s.sessionHostMu.Lock()
	host := s.sessionHosts[workspaceID+":"+sessionID]
	s.sessionHostMu.Unlock()
	if host == nil {
		return "", "", "", fmt.Errorf("Agent session is not active; execution does not wake it")
	}
	launched, user, cwd, active := host.SecretExecutionContext()
	if !active {
		return "", "", "", fmt.Errorf("Agent process is not active")
	}
	current, _, _, err := s.resolveContainerForWorkspaceContext(ctx, workspaceID)
	if err != nil || launched != current {
		return "", "", "", fmt.Errorf("Session container is missing or changed")
	}
	return current, user, cwd, nil
}

func (s *Server) cancelSecretExecutionsForOwner(workspace, session string) {
	s.secretExecMu.Lock()
	defer s.secretExecMu.Unlock()
	for _, job := range s.secretExecJobs {
		if job.WorkspaceID == workspace && (session == "" || job.SessionID == session) {
			job.Cancel()
		}
	}
}
