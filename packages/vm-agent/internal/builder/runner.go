// Package builder hosts the existing publish engine in a single-job DinD VM.
package builder

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/workspace/vm-agent/internal/publish"
)

const DefaultDaemonReadyTimeout = 60 * time.Second
const DefaultHeartbeatInterval = 15 * time.Second
const DefaultCallbackTimeout = 30 * time.Second
const MaxSpecBytes = 2 * 1024 * 1024

type Launch struct {
	ControlPlaneURL string    `json:"controlPlaneUrl"`
	ProjectID       string    `json:"projectId"`
	JobID           string    `json:"jobId"`
	Attempt         int       `json:"attempt"`
	Token           string    `json:"token"`
	DeadlineAt      time.Time `json:"deadlineAt"`
}
type Spec struct {
	DaemonReadyTimeoutMs int `json:"daemonReadyTimeoutMs"`
	HeartbeatIntervalMs  int `json:"heartbeatIntervalMs"`

	JobID          string            `json:"jobId"`
	Attempt        int               `json:"attempt"`
	Environment    string            `json:"environment"`
	EnvironmentID  string            `json:"environmentId"`
	Reference      string            `json:"reference"`
	AgentProfileID string            `json:"agentProfileId"`
	TaskID         string            `json:"taskId"`
	ContextURL     string            `json:"contextUrl"`
	ContextBytes   int64             `json:"contextBytes"`
	ContextSHA256  string            `json:"contextSha256"`
	MaxBytes       int64             `json:"maxBytes"`
	BuildEnv       map[string]string `json:"buildInterpolationEnv"`
	SecretKeys     []string          `json:"secretInterpolationKeys"`
}

// Callbacks never redirect a bearer token to another origin. Download/upload
// errors omit signed URLs; no token or capability is placed in the environment.
func Client(timeout time.Duration) *http.Client {
	return &http.Client{Timeout: timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return errors.New("redirect rejected") }}
}
func (l Launch) jobURL() string {
	return l.ControlPlaneURL + "/api/projects/" + l.ProjectID + "/deployment-publish-jobs/" + l.JobID
}

type callbackStatusError struct{ status int }

func (e callbackStatusError) Error() string {
	return fmt.Sprintf("builder callback returned %d", e.status)
}

const DefaultCallbackAttempts = 3
const DefaultCallbackRetryDelay = 5 * time.Second

func (l Launch) send(ctx context.Context, method, url string, body any, result any) error {
	var last error
	for attempt := 0; attempt < DefaultCallbackAttempts; attempt++ {
		last = l.sendOnce(ctx, method, url, body, result)
		if last == nil {
			return nil
		}
		var status callbackStatusError
		if errors.As(last, &status) && status.status < 500 {
			return last
		}
		if attempt+1 < DefaultCallbackAttempts {
			timer := time.NewTimer(DefaultCallbackRetryDelay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			case <-timer.C:
			}
		}
	}
	return last
}
func (l Launch) sendOnce(ctx context.Context, method, url string, body any, result any) error {
	var input io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		input = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, input)
	if err != nil {
		return errors.New("invalid callback URL")
	}
	req.Header.Set("Authorization", "Bearer "+l.Token)
	req.Header.Set("Content-Type", "application/json")
	response, err := Client(DefaultCallbackTimeout).Do(req)
	if err != nil {
		return errors.New("builder callback failed")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return callbackStatusError{response.StatusCode}
	}
	if result != nil {
		return json.NewDecoder(io.LimitReader(response.Body, MaxSpecBytes)).Decode(result)
	}
	return nil
}

func Run(parent context.Context, launch Launch) error {
	ctx, cancel := context.WithDeadline(parent, launch.DeadlineAt)
	defer cancel()
	var spec Spec
	if err := launch.send(ctx, http.MethodGet, launch.jobURL()+"/spec", nil, &spec); err != nil {
		return err
	}
	if spec.JobID != launch.JobID || spec.Attempt != launch.Attempt {
		return errors.New("builder spec identity mismatch")
	}
	if spec.DaemonReadyTimeoutMs < 1000 || spec.DaemonReadyTimeoutMs > 120000 || spec.HeartbeatIntervalMs < 1000 || spec.HeartbeatIntervalMs > 30000 {
		return errors.New("invalid builder timing configuration")
	}

	sink := publish.EventFunc(func(eventCtx context.Context, event publish.Event) {
		// Only safe, structured errors reach callbacks; Docker output is not attached
		// to the runner's terminal event (a RUN may print arbitrary credentials).
		_ = launch.send(eventCtx, http.MethodPost, launch.jobURL()+"/events", event, nil)
	})
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(time.Duration(spec.HeartbeatIntervalMs) * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				err := launch.send(ctx, http.MethodPost, launch.jobURL()+"/events", publish.Event{EventType: "publish.job.heartbeat", Message: "builder alive"}, nil)
				if err != nil { // A revoked job token or failed control plane never extends compute.
					cancel()
					return
				}
			}
		}
	}()
	err := run(ctx, launch, spec, sink)
	if err != nil {
		finalCtx, stop := context.WithTimeout(context.Background(), DefaultCallbackTimeout)
		defer stop()
		_ = launch.send(finalCtx, http.MethodPost, launch.jobURL()+"/events", publish.Event{Status: "failed", CurrentStep: "builder", Level: "error", EventType: "publish.builder.failed", Message: "Cloudflare build failed; inspect publish progress", ErrorCode: "cloudflare_build_failed", Terminal: true}, nil)
	}
	return err
}
func run(ctx context.Context, launch Launch, spec Spec, sink publish.EventSink) error {
	temp, err := os.MkdirTemp("", "sam-builder-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(temp)
	archive, err := os.CreateTemp(temp, "context-*.tar.zst")
	if err != nil {
		return err
	}
	defer archive.Close()
	if err = Download(ctx, Client(time.Until(launch.DeadlineAt)), spec.ContextURL, spec.ContextBytes, spec.ContextSHA256, spec.MaxBytes, archive); err != nil {
		return err
	}
	source := filepath.Join(temp, "source")
	if err = os.Mkdir(source, 0700); err != nil {
		return err
	}
	if err = Extract(ctx, archive, source, spec.MaxBytes); err != nil {
		return err
	}
	if err = archive.Close(); err != nil {
		return err
	}
	if err = os.Remove(archive.Name()); err != nil {
		return err
	}
	daemon := exec.CommandContext(ctx, "dockerd", "--host=unix:///var/run/docker.sock", "--iptables=false", "--ip6tables=false", "--ip-forward=false", "--exec-opt", "native.cgroupdriver=cgroupfs")
	// Keep daemon diagnostics off callbacks; never print a job launch payload.
	daemon.Stdout = os.Stderr
	daemon.Stderr = os.Stderr
	if err = daemon.Start(); err != nil {
		return errors.New("dockerd failed to start")
	}
	defer func() { _ = daemon.Process.Signal(os.Interrupt); _ = daemon.Process.Kill(); _ = daemon.Wait() }()
	readyCtx, readyCancel := context.WithTimeout(ctx, time.Duration(spec.DaemonReadyTimeoutMs)*time.Millisecond)
	defer readyCancel()
	for {
		if exec.CommandContext(readyCtx, "docker", "info").Run() == nil {
			break
		}
		select {
		case <-readyCtx.Done():
			return errors.New("dockerd readiness deadline")
		case <-time.After(200 * time.Millisecond):
		}
	}
	sink.Event(ctx, publish.Event{Status: "building", CurrentStep: "builder_ready", EventType: "publish.builder.ready", Message: "DinD builder ready"})
	artifact, err := publish.Build(ctx, publish.BuildOptions{WorkspaceDir: source, Reference: spec.Reference, BuildEnv: spec.BuildEnv, SecretKeys: spec.SecretKeys, BuildNetwork: "host", Events: sink})
	if err != nil {
		return errors.New("compose build failed")
	}
	plane := publish.NewHTTPControlPlane(publish.HTTPControlPlaneOptions{BaseURL: launch.ControlPlaneURL, Token: launch.Token, Client: Client(DefaultCallbackTimeout)})
	orchestrator := publish.New(publish.Options{PublishJobID: launch.JobID, Attempt: launch.Attempt, ControlPlane: plane, Docker: publish.NewHostDocker(), HTTPClient: Client(time.Until(launch.DeadlineAt)), Events: sink})
	result, err := orchestrator.Publish(ctx, launch.ProjectID, spec.Environment, spec.EnvironmentID, artifact, &publish.ReleaseSubmittedBy{AgentProfileID: spec.AgentProfileID, TaskID: spec.TaskID})
	if err != nil {
		return errors.New("image publication failed")
	}
	return launch.send(ctx, http.MethodPost, launch.jobURL()+"/events", publish.Event{Status: "succeeded", CurrentStep: "complete", EventType: "publish.job.completed", Message: "Cloudflare publish complete", Terminal: true, ReleaseID: result.ReleaseID, ReleaseVersion: result.Version, ReleaseStatus: result.Status}, nil)
}
