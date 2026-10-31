package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/transferscratch"
)

type workspaceDeletionIdentity struct {
	WorkspaceID              string `json:"workspaceId"`
	NodeID                   string `json:"nodeId"`
	NodeRuntimeIncarnationID string `json:"nodeRuntimeIncarnationId"`
	UserID                   string `json:"userId"`
	WorkspaceGeneration      string `json:"workspaceGeneration"`
}
type workspaceDeletionRequest struct {
	workspaceDeletionIdentity
	DeletionMode          string `json:"deletionMode"`
	PreservationExpiresAt string `json:"preservationExpiresAt,omitempty"`
}
type workspaceDeletionIntent struct {
	workspaceDeletionIdentity
	DeletionMode          string   `json:"deletionMode"`
	PreservationExpiresAt string   `json:"preservationExpiresAt,omitempty"`
	Root                  string   `json:"root"`
	RootDevice            uint64   `json:"rootDevice"`
	RootInode             uint64   `json:"rootInode"`
	Containers            []string `json:"containers"`
	Volume                string   `json:"volume"`
	VolumeIdentity        string   `json:"volumeIdentity"`
	Standalone            bool     `json:"standalone"`
	Finalized             bool     `json:"finalized"`
	Completed             bool     `json:"completed"`
}

func deletionDocker(ctx context.Context, args ...string) (string, error) {
	out, err := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker %s: %w: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}
func (s *Server) saveWorkspaceDeletion(d *workspaceDeletionIntent) error {
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	return s.store.PutWorkspaceDeletion(d.WorkspaceID, string(b))
}
func (s *Server) handleSafeDeleteWorkspace(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), s.workspaceDeletionAttemptTimeout())
	defer cancel()
	r = r.WithContext(ctx)
	id := r.PathValue("workspaceId")
	if !s.requireNodeManagementAuth(w, r, id) {
		return
	}
	var body workspaceDeletionRequest
	decoder := json.NewDecoder(io.LimitReader(r.Body, 4096))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || decoder.Decode(new(any)) != io.EOF || body.WorkspaceID != id || id == "" {
		writeError(w, 400, "exact workspace deletion identity required")
		return
	}
	identity := body.workspaceDeletionIdentity
	if err := validateDeletionAuthority(body.DeletionMode, body.PreservationExpiresAt); err != nil {
		writeError(w, 409, err.Error())
		return
	}
	// Node-management JWTs identify the owner through their validated subject.
	token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	claims, err := s.jwtValidator.ValidateNodeManagementToken(token, id)
	if err != nil || identity.UserID == "" || identity.UserID != claims.Subject || identity.UserID != s.config.NodeUserID || identity.NodeID == "" || identity.NodeID != s.config.NodeID || identity.NodeRuntimeIncarnationID == "" || identity.NodeRuntimeIncarnationID != s.config.NodeRuntimeIncarnationID {
		writeError(w, 409, "node deletion ownership or incarnation mismatch")
		return
	}
	lock := s.workspaceLifecycleLock(id)
	if err := lock.Lock(r.Context()); err != nil {
		writeError(w, 408, "workspace lifecycle operation canceled")
		return
	}
	defer lock.Unlock()
	if s.store == nil {
		writeError(w, 503, "deletion persistence unavailable")
		return
	}
	payload, err := s.store.GetWorkspaceDeletion(id)
	if err != nil {
		writeError(w, 503, "deletion persistence unavailable")
		return
	}
	var d workspaceDeletionIntent
	if payload != "" {
		if json.Unmarshal([]byte(payload), &d) != nil || d.workspaceDeletionIdentity != identity || (d.DeletionMode != body.DeletionMode && !(d.DeletionMode == "automatic" && body.DeletionMode == "explicit")) {
			writeError(w, 409, "another deletion identity owns this workspace")
			return
		}
		if d.DeletionMode == "automatic" && body.DeletionMode == "explicit" {
			// Only a new authenticated human-deletion request can promote authority.
			d.DeletionMode = "explicit"
			d.PreservationExpiresAt = ""
			if err := s.saveWorkspaceDeletion(&d); err != nil {
				writeError(w, 503, "cannot persist explicit deletion authority")
				return
			}
		}
		if d.DeletionMode == "automatic" && d.PreservationExpiresAt != body.PreservationExpiresAt {
			// Only a fresh authenticated control-plane authorization can renew expiry.
			d.PreservationExpiresAt = body.PreservationExpiresAt
			if err := s.saveWorkspaceDeletion(&d); err != nil {
				writeError(w, 503, "cannot persist preservation renewal")
				return
			}
		}
	} else {
		meta, err := s.store.GetWorkspaceMetadata(id)
		if err != nil || meta == nil || meta.EvictionGeneration != identity.WorkspaceGeneration {
			writeError(w, 409, "workspace generation or durable metadata unavailable")
			return
		}
		d = workspaceDeletionIntent{workspaceDeletionIdentity: identity, Root: meta.WorkspaceDir, DeletionMode: body.DeletionMode, PreservationExpiresAt: body.PreservationExpiresAt, Volume: bootstrap.VolumeNameForWorkspace(id)}
		expected := filepath.Join(s.config.WorkspaceDir, id)
		if id == "." || id == ".." || strings.ContainsAny(id, "/\\") || filepath.Clean(d.Root) != expected || meta.ContainerLabelVal != d.Root {
			writeError(w, 409, "workspace artifact ownership is unproven")
			return
		}
		if err := validateDeletionRoot(d.Root); err != nil {
			writeError(w, 409, err.Error())
			return
		}
		d.RootDevice, d.RootInode, err = deletionRootIdentity(d.Root)
		if err != nil {
			writeError(w, 409, err.Error())
			return
		}
		if d.RootInode != 0 {
			owned, err := s.store.GetOwnedWorkspaceRoot(id)
			var proof workspaceDeletionIntent
			if err != nil || owned == "" || json.Unmarshal([]byte(owned), &proof) != nil || proof.Root != d.Root || proof.NodeID != identity.NodeID || proof.NodeRuntimeIncarnationID != identity.NodeRuntimeIncarnationID || proof.UserID != identity.UserID || proof.RootDevice != d.RootDevice || proof.RootInode != d.RootInode {
				writeError(w, 409, "host workspace root ownership is unproven")
				return
			}
		}
		if s.config.IsStandaloneMode() {
			d.Standalone = true
			d.Volume = ""
		} else {
			ids, err := deletionDocker(r.Context(), "ps", "-aq", "--no-trunc", "--filter", "label="+s.config.ContainerLabelKey+"="+meta.ContainerLabelVal)
			if err != nil {
				writeError(w, 503, err.Error())
				return
			}
			d.Containers = strings.Fields(ids)
			d.VolumeIdentity, err = deletionVolumeIdentity(r.Context(), d.Volume)
			if err == nil && d.VolumeIdentity != "" {
				err = validateDeletionVolumeOwnership(d.VolumeIdentity, identity)
			}
			if err != nil {
				writeError(w, 503, err.Error())
				return
			}
		}
		if err := s.saveWorkspaceDeletion(&d); err != nil {
			writeError(w, 503, "cannot persist deletion intent")
			return
		}
	}
	if err := s.applyWorkspaceDeletion(r.Context(), &d); err != nil {
		writeError(w, 503, "physical cleanup pending: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, struct {
		workspaceDeletionIdentity
		PhysicalDeleted bool `json:"physicalDeleted"`
		Success         bool `json:"success"`
	}{identity, true, true})
}
func deletionVolumeIdentity(ctx context.Context, name string) (string, error) {
	// Listing distinguishes absence from daemon/inspect failures without parsing error text.
	names, err := deletionDocker(ctx, "volume", "ls", "--filter", "name=^"+regexp.QuoteMeta(name)+"$", "--format", "{{.Name}}")
	if err != nil {
		return "", err
	}
	for _, n := range strings.Fields(names) {
		if n == name {
			return deletionDocker(ctx, "volume", "inspect", "--format", `{{.Name}}|{{.CreatedAt}}|{{.Mountpoint}}|{{index .Labels "sam.workspace.id"}}|{{index .Labels "sam.node.id"}}|{{index .Labels "sam.node.incarnation"}}|{{index .Labels "sam.owner.id"}}`, name)
		}
	}
	return "", nil
}

// Caller holds the same lifecycle lock used by create/rebuild/restore/eviction.
func (s *Server) applyWorkspaceDeletion(ctx context.Context, d *workspaceDeletionIntent) error {
	if err := validateDeletionAuthority(d.DeletionMode, d.PreservationExpiresAt); err != nil {
		return err
	}
	if d.DeletionMode == "automatic" {
		expiry, _ := time.Parse(time.RFC3339Nano, d.PreservationExpiresAt)
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, expiry)
		defer cancel()
	}
	if d.WorkspaceID == "" || d.WorkspaceID == "." || d.WorkspaceID == ".." || strings.ContainsAny(d.WorkspaceID, "/\\") || d.Root != filepath.Join(s.config.WorkspaceDir, d.WorkspaceID) || d.Standalone != s.config.IsStandaloneMode() {
		return errors.New("persisted deletion artifact ownership is invalid")
	}
	if d.NodeID != s.config.NodeID || d.NodeRuntimeIncarnationID != s.config.NodeRuntimeIncarnationID || d.UserID != s.config.NodeUserID {
		return errors.New("deletion incarnation changed")
	}
	meta, err := s.store.GetWorkspaceMetadata(d.WorkspaceID)
	if err != nil {
		return err
	}
	if meta != nil && (meta.EvictionGeneration != d.WorkspaceGeneration || meta.WorkspaceDir != d.Root) {
		return errors.New("workspace artifact generation changed")
	}
	if d.Completed {
		return s.finishWorkspaceDeletion(ctx, d)
	}
	if meta == nil {
		return errors.New("workspace metadata missing before physical deletion")
	}
	if runtime, ok := s.getWorkspaceRuntime(d.WorkspaceID); ok && runtime.EvictionGeneration != d.WorkspaceGeneration {
		return errors.New("runtime generation changed")
	}
	if err := validateDeletionRoot(d.Root); err != nil {
		return err
	}
	dev, ino, err := deletionRootIdentity(d.Root)
	if err != nil {
		return err
	}
	if ino != 0 && (ino != d.RootInode || dev != d.RootDevice) {
		return errors.New("host root identity changed")
	}
	s.stopSessionHostsForWorkspace(d.WorkspaceID)
	s.stopPortScanner(d.WorkspaceID)
	s.shutdownReporter(d.WorkspaceID)
	s.stopResourceHistoryForWorkspace(d.WorkspaceID, ctx)
	if !d.Standalone {
		ids, err := deletionDocker(ctx, "ps", "-aq", "--no-trunc", "--filter", "label="+s.config.ContainerLabelKey+"="+d.Root)
		if err != nil {
			return err
		}
		for _, id := range strings.Fields(ids) {
			if !containsDeletionID(d.Containers, id) {
				return errors.New("workspace container identity changed")
			}
		}
		for _, id := range strings.Fields(ids) {
			if _, err := deletionDocker(ctx, "rm", "-f", id); err != nil {
				return err
			}
		}
		volume, err := deletionVolumeIdentity(ctx, d.Volume)
		if err != nil {
			return err
		}
		if volume != "" {
			if volume != d.VolumeIdentity {
				return errors.New("workspace volume identity changed")
			}
			parts := strings.Split(volume, "|")
			if len(parts) != 7 {
				return errors.New("workspace volume mount identity unavailable")
			}
			if err := validateDeletionRoot(parts[2]); err != nil {
				return err
			}
			// Never remove user/nested mounts or volumes. No force and no recursive volume deletion.
			if _, err := deletionDocker(ctx, "volume", "rm", d.Volume); err != nil {
				return err
			}
		}
	}
	if err := validateDeletionRoot(d.Root); err != nil {
		return err
	}
	dev, ino, err = deletionRootIdentity(d.Root)
	if err != nil {
		return err
	}
	if ino != 0 && (ino != d.RootInode || dev != d.RootDevice) {
		return errors.New("host root identity changed before removal")
	}
	budget := s.config.WorkspaceDeletionMaxEntries
	if budget <= 0 {
		budget = config.DefaultWorkspaceDeletionMaxEntries
	}
	if err := removeDeletionRoot(ctx, d.Root, d.RootDevice, d.RootInode, budget); err != nil {
		return err
	}
	if err := s.verifyDeletionAbsent(ctx, d); err != nil {
		return err
	}
	d.Completed = true
	if err := s.saveWorkspaceDeletion(d); err != nil {
		return err
	}
	return s.finishWorkspaceDeletion(ctx, d)
}
func (s *Server) finishWorkspaceDeletion(ctx context.Context, d *workspaceDeletionIntent) error {
	if err := s.verifyDeletionAbsent(ctx, d); err != nil {
		return err
	}
	if err := bootstrap.RemoveCredentialHelperFromHost(d.WorkspaceID); err != nil {
		return err
	}
	for _, cleanup := range []func(string) error{s.store.DeleteWorkspaceTabs, s.store.DeleteWorkspaceMcpServers, s.store.DeleteWorkspaceExecutionProtocol, s.store.DeleteWorkspaceMetadata} {
		if err := cleanup(d.WorkspaceID); err != nil {
			return err
		}
	}
	s.removeWorkspaceRuntime(d.WorkspaceID)
	if err := s.store.DeleteOwnedWorkspaceRoot(d.WorkspaceID); err != nil {
		return err
	}
	d.Finalized = true
	return s.saveWorkspaceDeletion(d)
}

func containsDeletionID(ids []string, id string) bool {
	for _, v := range ids {
		if v == id {
			return true
		}
	}
	return false
}
func (s *Server) reconcileWorkspaceDeletions(ctx context.Context) {
	if s.store == nil {
		return
	}
	batch := s.config.WorkspaceDeletionBatchSize
	if batch <= 0 {
		batch = config.DefaultWorkspaceDeletionBatchSize
	}
	items, err := s.store.WorkspaceDeletions(batch)
	if err != nil {
		return
	}
	for _, payload := range items {
		var d workspaceDeletionIntent
		if json.Unmarshal([]byte(payload), &d) != nil || d.Finalized {
			continue
		}
		lock := s.workspaceLifecycleLock(d.WorkspaceID)
		if lock.Lock(ctx) != nil {
			return
		}
		attemptCtx, cancel := context.WithTimeout(ctx, s.workspaceDeletionAttemptTimeout())
		err := s.applyWorkspaceDeletion(attemptCtx, &d)
		cancel()
		if err != nil {
			_ = s.saveWorkspaceDeletion(&d)
		}
		lock.Unlock()
		if err != nil {
			slog.Warn("Workspace physical cleanup remains pending", "workspace", d.WorkspaceID, "error", err)
		}
	}
}
func (s *Server) startWorkspaceDeletionReconciler() {
	lifetime, cancelLifetime := context.WithCancel(context.Background())
	s.workspaceLifecycleMu.Lock()
	if s.workspaceDeletionDone != nil {
		s.workspaceLifecycleMu.Unlock()
		cancelLifetime()
		return
	}
	s.workspaceDeletionCancel = cancelLifetime
	s.workspaceDeletionDone = make(chan struct{})
	done := s.workspaceDeletionDone
	s.workspaceLifecycleMu.Unlock()
	go func() {
		defer close(done)
		interval := s.config.WorkspaceDeletionRetryInterval
		if interval <= 0 {
			interval = config.DefaultWorkspaceDeletionRetryInterval
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			ctx, cancel := context.WithTimeout(lifetime, interval)
			s.reconcileWorkspaceDeletions(ctx)
			s.inventoryWorkspaceCleanup(ctx)
			retention := s.config.WorkspaceDeletionTombstoneRetention
			if retention <= 0 {
				retention = config.DefaultWorkspaceDeletionTombstoneRetention
			}
			batch := s.config.WorkspaceDeletionBatchSize
			if batch <= 0 {
				batch = config.DefaultWorkspaceDeletionBatchSize
			}
			if s.store != nil {
				if _, err := s.store.PruneFinalizedWorkspaceDeletions(time.Now().Add(-retention), batch); err != nil {
					slog.Warn("Workspace deletion tombstone cleanup failed", "error", err)
				}
			}
			transferscratch.SweepFromEnvironment(ctx)
			cancel()
			select {
			case <-s.done:
				return
			case <-lifetime.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}

func (s *Server) requireNoWorkspaceDeletion(id string) error {
	if s.store == nil {
		return nil
	}
	payload, err := s.store.GetWorkspaceDeletion(id)
	if err != nil {
		return errors.Join(errWorkspaceMetadataUnavailable, err)
	}
	if payload != "" {
		return errors.New("workspace deletion owns lifecycle; workspace cannot be recreated")
	}
	return nil
}

func (s *Server) verifyDeletionAbsent(ctx context.Context, d *workspaceDeletionIntent) error {
	if _, err := os.Lstat(d.Root); !os.IsNotExist(err) {
		return errors.New("host workspace root absence unconfirmed")
	}
	if d.Standalone {
		return nil
	}
	if ids, err := deletionDocker(ctx, "ps", "-aq", "--no-trunc", "--filter", "label="+s.config.ContainerLabelKey+"="+d.Root); err != nil || ids != "" {
		return errors.New("container absence unconfirmed")
	}
	if vol, err := deletionVolumeIdentity(ctx, d.Volume); err != nil || vol != "" {
		return errors.New("volume absence unconfirmed")
	}
	return nil
}

func (s *Server) workspaceDeletionAttemptTimeout() time.Duration {
	if s.config.WorkspaceDeletionAttemptTimeout > 0 {
		return s.config.WorkspaceDeletionAttemptTimeout
	}
	return config.DefaultWorkspaceDeletionAttemptTimeout
}

func (s *Server) stopWorkspaceDeletionReconciler() {
	s.workspaceLifecycleMu.Lock()
	cancel, done := s.workspaceDeletionCancel, s.workspaceDeletionDone
	s.workspaceLifecycleMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}
