package acp

import (
	"slices"
	"testing"
)

// A workspace reused by a later task keeps the /etc/sam/env written when it was
// provisioned for the first one.
func TestMergeSAMEnvFallbackSessionIdentityBeatsStaleEnvFile(t *testing.T) {
	envFile := []string{
		"SAM_WORKSPACE_ID=ws-1",
		"SAM_PROJECT_ID=proj-1",
		"SAM_TASK_ID=task-first",
		"SAM_BRANCH=sam/first-branch",
		"PROJECT_SETTING=from-project-env",
	}
	sessionEnv := []string{
		"SAM_API_URL=https://api.example.com",
		"SAM_WORKSPACE_ID=ws-1",
		"SAM_PROJECT_ID=proj-1",
		"SAM_TASK_ID=task-second",
		"SAM_TASK_MODE=conversation",
		"SAM_CHAT_SESSION_ID=chat-second",
		"SAM_BRANCH=sam/fallback-branch",
	}

	got := mergeSAMEnvFallback(slices.Clone(envFile), sessionEnv)

	for _, want := range []string{
		"SAM_TASK_ID=task-second",
		"SAM_TASK_MODE=conversation",
		"SAM_CHAT_SESSION_ID=chat-second",
		"SAM_PROJECT_ID=proj-1",
		"SAM_WORKSPACE_ID=ws-1",
		// Not identity: the env file keeps its value, the fallback only fills gaps.
		"SAM_BRANCH=sam/first-branch",
		"SAM_API_URL=https://api.example.com",
		"PROJECT_SETTING=from-project-env",
	} {
		if !hasEnvEntry(got, want) {
			t.Errorf("merged env is missing %q: %v", want, got)
		}
	}
	for _, key := range []string{"SAM_TASK_ID", "SAM_WORKSPACE_ID", "SAM_BRANCH"} {
		if n := len(envEntriesWithKey(got, key)); n != 1 {
			t.Errorf("%s appears %d times: %v", key, n, got)
		}
	}
}

// A key the session cannot vouch for is absent from its fallback, so the env
// file's value survives rather than being blanked.
func TestMergeSAMEnvFallbackKeepsEnvFileIdentityTheSessionLacks(t *testing.T) {
	got := mergeSAMEnvFallback(
		[]string{"SAM_CHAT_SESSION_ID=chat-file"},
		[]string{"SAM_WORKSPACE_ID=ws-1"},
	)
	if !hasEnvEntry(got, "SAM_CHAT_SESSION_ID=chat-file") || !hasEnvEntry(got, "SAM_WORKSPACE_ID=ws-1") {
		t.Fatalf("merged env = %v", got)
	}
}
