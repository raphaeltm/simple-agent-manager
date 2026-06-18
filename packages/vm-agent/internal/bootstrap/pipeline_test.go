package bootstrap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/workspace/vm-agent/internal/bootlog"
	"github.com/workspace/vm-agent/internal/config"
)

type recordedBootlogEvent struct {
	step    string
	status  string
	message string
}

type recordingBroadcaster struct {
	events []recordedBootlogEvent
}

func (b *recordingBroadcaster) Broadcast(step, status, message string, _ ...string) {
	b.events = append(b.events, recordedBootlogEvent{step: step, status: status, message: message})
}

func TestRunBootstrapPlanExecutesStepsInOrder(t *testing.T) {
	var calls []string
	plan := []bootstrapStep{
		testStep("first", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			calls = append(calls, "first")
			return okResult()
		}),
		testStep("second", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			calls = append(calls, "second")
			return okResult()
		}),
		testStep("third", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			calls = append(calls, "third")
			return okResult()
		}),
	}

	if err := runBootstrapPlan(context.Background(), plan, &workspaceBootstrapContext{}); err != nil {
		t.Fatalf("runBootstrapPlan returned error: %v", err)
	}

	want := []string{"first", "second", "third"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected call order: got %v, want %v", calls, want)
	}
}

func TestRunBootstrapPlanStopsOnRequiredStepFailure(t *testing.T) {
	stepErr := errors.New("required failed")
	var calls []string
	plan := []bootstrapStep{
		testStep("first", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			calls = append(calls, "first")
			return okResult()
		}),
		testStep("second", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			calls = append(calls, "second")
			return errResult(stepErr)
		}),
		testStep("third", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			calls = append(calls, "third")
			return okResult()
		}),
	}

	err := runBootstrapPlan(context.Background(), plan, &workspaceBootstrapContext{})
	if !errors.Is(err, stepErr) {
		t.Fatalf("expected required step error, got %v", err)
	}

	want := []string{"first", "second"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected call order after failure: got %v, want %v", calls, want)
	}
}

func TestRunBootstrapPlanContinuesAfterOptionalStepFailure(t *testing.T) {
	var calls []string
	plan := []bootstrapStep{
		testStep("first", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			calls = append(calls, "first")
			return okResult()
		}),
		testStep("second", false, func(context.Context, *workspaceBootstrapContext) StepResult {
			calls = append(calls, "second")
			return warningResult("non-fatal failed", errors.New("optional failed"))
		}),
		testStep("third", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			calls = append(calls, "third")
			return okResult()
		}),
	}

	if err := runBootstrapPlan(context.Background(), plan, &workspaceBootstrapContext{}); err != nil {
		t.Fatalf("runBootstrapPlan returned error: %v", err)
	}

	want := []string{"first", "second", "third"}
	if !reflect.DeepEqual(calls, want) {
		t.Fatalf("unexpected call order: got %v, want %v", calls, want)
	}
}

func TestRunBootstrapPlanRunsCleanupOnFailureOnly(t *testing.T) {
	var cleanupCalls []string
	failPlan := []bootstrapStep{
		testStep("register", true, func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			b.cleanup.register("first", func() { cleanupCalls = append(cleanupCalls, "first") })
			b.cleanup.register("second", func() { cleanupCalls = append(cleanupCalls, "second") })
			return okResult()
		}),
		testStep("fail", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			return errResult(errors.New("boom"))
		}),
	}

	if err := runBootstrapPlan(context.Background(), failPlan, &workspaceBootstrapContext{}); err == nil {
		t.Fatal("expected failure")
	}
	if want := []string{"second", "first"}; !reflect.DeepEqual(cleanupCalls, want) {
		t.Fatalf("unexpected cleanup order: got %v, want %v", cleanupCalls, want)
	}

	cleanupCalls = nil
	successPlan := []bootstrapStep{
		testStep("register", true, func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			b.cleanup.register("first", func() { cleanupCalls = append(cleanupCalls, "first") })
			return okResult()
		}),
	}
	if err := runBootstrapPlan(context.Background(), successPlan, &workspaceBootstrapContext{}); err != nil {
		t.Fatalf("unexpected success plan error: %v", err)
	}
	if len(cleanupCalls) != 0 {
		t.Fatalf("cleanup should not run on success, got %v", cleanupCalls)
	}
}

func TestRunBootstrapPlanDoesNotCleanupAfterDisarm(t *testing.T) {
	var cleanupCalled bool
	plan := []bootstrapStep{
		testStep("register", true, func(_ context.Context, b *workspaceBootstrapContext) StepResult {
			b.cleanup.register("credential helper", func() { cleanupCalled = true })
			return okResult()
		}),
		disarmCredentialCleanupStep(),
		testStep("callback", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			return errResult(&CallbackError{Err: errors.New("ready failed"), Status: workspaceReadyStatusRunning})
		}),
	}

	if err := runBootstrapPlan(context.Background(), plan, &workspaceBootstrapContext{}); err == nil {
		t.Fatal("expected callback failure")
	}
	if cleanupCalled {
		t.Fatal("cleanup should stay disarmed after workspace provisioning succeeds")
	}
}

func TestRunBootstrapPlanReporterEventOrder(t *testing.T) {
	broadcaster := &recordingBroadcaster{}
	reporter := bootlog.New("http://example.invalid", "ws-pipeline")
	reporter.SetBroadcaster(broadcaster)

	plan := []bootstrapStep{
		{
			name:           "required",
			required:       true,
			startMessage:   "starting required",
			successMessage: "required complete",
			run: func(context.Context, *workspaceBootstrapContext) StepResult {
				return okResult()
			},
		},
		{
			name:           "optional",
			required:       false,
			startMessage:   "starting optional",
			failureMessage: "optional failed",
			run: func(context.Context, *workspaceBootstrapContext) StepResult {
				return warningResult("optional failed", errors.New("optional failed"))
			},
		},
		{
			name:           "after",
			required:       true,
			startMessage:   "starting after",
			successMessage: "after complete",
			run: func(context.Context, *workspaceBootstrapContext) StepResult {
				return okResult()
			},
		},
	}

	if err := runBootstrapPlan(context.Background(), plan, &workspaceBootstrapContext{reporter: reporter}); err != nil {
		t.Fatalf("runBootstrapPlan returned error: %v", err)
	}

	got := broadcaster.events
	want := []recordedBootlogEvent{
		{step: "required", status: "started", message: "starting required"},
		{step: "required", status: "completed", message: "required complete"},
		{step: "optional", status: "started", message: "starting optional"},
		{step: "optional", status: "failed", message: "optional failed"},
		{step: "after", status: "started", message: "starting after"},
		{step: "after", status: "completed", message: "after complete"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("unexpected reporter events:\ngot:  %#v\nwant: %#v", got, want)
	}
}

func TestPrepareDevcontainerCacheStepIsNonFatal(t *testing.T) {
	mockBinDir := t.TempDir()
	mockDocker := filepath.Join(mockBinDir, "docker")
	if err := os.WriteFile(mockDocker, []byte("#!/bin/sh\necho login failed >&2\nexit 1\n"), 0o755); err != nil {
		t.Fatalf("failed to write mock docker command: %v", err)
	}
	t.Setenv("PATH", mockBinDir+":"+os.Getenv("PATH"))

	var afterCacheRan bool
	plan := []bootstrapStep{
		prepareDevcontainerCacheStep(),
		testStep("after-cache", true, func(context.Context, *workspaceBootstrapContext) StepResult {
			afterCacheRan = true
			return okResult()
		}),
	}
	bootstrapCtx := &workspaceBootstrapContext{
		cfg: &config.Config{
			DevcontainerCacheEnabled:  true,
			DevcontainerCacheRegistry: "ghcr.io",
			Repository:                "owner/repo",
		},
		bootstrap:                 &bootstrapState{GitHubToken: "token"},
		repoHasDevcontainerConfig: true,
	}

	if err := runBootstrapPlan(context.Background(), plan, bootstrapCtx); err != nil {
		t.Fatalf("cache failure should be non-fatal, got %v", err)
	}
	if !afterCacheRan {
		t.Fatal("expected plan to continue after cache preparation failure")
	}
	if bootstrapCtx.devcontainerCacheRef != "" {
		t.Fatalf("expected cache ref to be cleared after login failure, got %q", bootstrapCtx.devcontainerCacheRef)
	}
}

func testStep(name string, required bool, run func(context.Context, *workspaceBootstrapContext) StepResult) bootstrapStep {
	return bootstrapStep{name: name, required: required, run: run}
}
