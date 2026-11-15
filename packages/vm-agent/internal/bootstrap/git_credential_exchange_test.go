package bootstrap

import (
	"context"
	"errors"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
	"github.com/workspace/vm-agent/internal/container"
)

func newExchangeTestConfig(t *testing.T) *config.Config {
	t.Helper()
	workspaceID := fmt.Sprintf("ws-exchange-%d", time.Now().UnixNano())
	t.Cleanup(func() { _ = RemoveCredentialHelperFromHost(workspaceID) })
	return &config.Config{
		WorkspaceID:   workspaceID,
		Repository:    "https://github.com/test/repo",
		CallbackToken: "callback-token",
		Port:          8080,
	}
}

func mustWriteHostHelper(t *testing.T, cfg *config.Config) (hostPath, script string, minted bool) {
	t.Helper()
	hostPath, script, minted, err := writeCredentialHelperToHost(cfg)
	if err != nil {
		t.Fatalf("writeCredentialHelperToHost: %v", err)
	}
	return hostPath, script, minted
}

// A running devcontainer keeps the helper inode it was started with, so the
// bearer in the FIRST helper is what the container presents after any later
// reprovision. That bearer must keep validating.
func TestReprovisionKeepsRunningContainersExchangeBearerValid(t *testing.T) {
	cfg := newExchangeTestConfig(t)

	hostPath, containerView, minted := mustWriteHostHelper(t, cfg)
	if !minted {
		t.Fatal("first provisioning must mint a bearer")
	}
	containerToken := ExchangeTokenFromHelperScript(containerView)
	if containerToken == "" {
		t.Fatal("rendered helper carries no exchange bearer")
	}
	before, err := os.Stat(hostPath)
	if err != nil {
		t.Fatal(err)
	}

	// Reprovision with identical inputs (rebuild, restart, recovery, restore).
	_, script, minted := mustWriteHostHelper(t, cfg)
	if minted {
		t.Fatal("reprovision must reuse the workspace's bearer, not mint a new one")
	}
	if script != containerView {
		t.Fatal("reprovision with identical inputs must render the identical helper")
	}
	after, err := os.Stat(hostPath)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) {
		t.Fatal("an unchanged helper must not be replaced: a bind mount pins the old inode")
	}
	if !ValidateGitCredentialExchange(cfg.WorkspaceID, containerToken) {
		t.Fatal("the running container's bearer stopped validating after reprovision")
	}
}

// When the rendered helper changes (template or port change in a newer agent),
// the file is replaced and the container keeps the OLD inode; its bearer must
// still be the workspace's bearer.
func TestReprovisionWithChangedHelperKeepsOldInodeBearerValid(t *testing.T) {
	cfg := newExchangeTestConfig(t)
	_, containerView, _ := mustWriteHostHelper(t, cfg)

	cfg.GitCredentialTimeout = 7 * time.Second
	_, script, minted := mustWriteHostHelper(t, cfg)
	if minted {
		t.Fatal("a helper change must not rotate the bearer")
	}
	if script == containerView {
		t.Fatal("test setup: expected the rendered helper to change")
	}
	if got, want := ExchangeTokenFromHelperScript(script), ExchangeTokenFromHelperScript(containerView); got != want {
		t.Fatal("replacement helper must embed the same bearer as the running container's helper")
	}
	if !ValidateGitCredentialExchange(cfg.WorkspaceID, ExchangeTokenFromHelperScript(containerView)) {
		t.Fatal("the running container's bearer stopped validating after the helper changed")
	}
}

// A helper written by an agent build that predates the exchange bearer, or a
// helper whose bearer a deliberately rotated digest no longer accepts, cannot be
// reused: a fresh bearer is minted.
func TestHelperWithoutValidBearerIsReplacedWithFreshBearer(t *testing.T) {
	cases := map[string]struct {
		helper        string
		installDigest bool
	}{
		"pre-bearer agent helper":          {helper: "#!/bin/sh\ncredential_query=\"?workspaceId=x\"\ncurl -fsS http://host/git-credential\n"},
		"bearer the digest does not match": {helper: "#!/bin/sh\nexchange_token='rotated-away-bearer'\n", installDigest: true},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			assertStaleHelperGetsFreshBearerInPlace(t, tc.helper, tc.installDigest)
		})
	}
}

func assertStaleHelperGetsFreshBearerInPlace(t *testing.T, staleHelper string, installDigest bool) {
	t.Helper()
	cfg := newExchangeTestConfig(t)
	hostPath := credentialHelperHostPath(cfg.WorkspaceID)
	if err := os.WriteFile(hostPath, []byte(staleHelper), 0o755); err != nil {
		t.Fatal(err)
	}
	if installDigest {
		if err := InstallGitCredentialExchange(cfg.WorkspaceID, "current-digest-bearer"); err != nil {
			t.Fatal(err)
		}
	}
	before := mustStat(t, hostPath)
	_, script, minted := mustWriteHostHelper(t, cfg)
	if !minted {
		t.Fatal("a helper with no accepted bearer must not be reused")
	}
	if ValidateGitCredentialExchange(cfg.WorkspaceID, ExchangeTokenFromHelperScript(staleHelper)) {
		t.Fatal("the stale helper's bearer must not validate")
	}
	if !ValidateGitCredentialExchange(cfg.WorkspaceID, ExchangeTokenFromHelperScript(script)) {
		t.Fatal("the fresh helper's bearer must validate")
	}
	// A running container's bind mount is pinned to the existing inode; a
	// minted bearer must reach it, so the file is rewritten in place.
	if !os.SameFile(before, mustStat(t, hostPath)) {
		t.Fatal("a minted bearer must be written into the existing helper inode")
	}
}

func mustStat(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

// A lost digest (a /tmp cleaner, a partial cleanup) must not rotate the bearer
// under a running container: the digest is reinstalled from the helper's bearer.
func TestLostDigestIsReinstalledFromHelperBearer(t *testing.T) {
	cfg := newExchangeTestConfig(t)
	_, containerView, _ := mustWriteHostHelper(t, cfg)
	token := ExchangeTokenFromHelperScript(containerView)
	if err := os.Remove(gitCredentialExchangeDigestPath(cfg.WorkspaceID)); err != nil {
		t.Fatal(err)
	}
	if ValidateGitCredentialExchange(cfg.WorkspaceID, token) {
		t.Fatal("test setup: bearer must not validate without a digest")
	}

	_, script, minted := mustWriteHostHelper(t, cfg)
	if minted || ExchangeTokenFromHelperScript(script) != token {
		t.Fatal("a lost digest must be reinstalled from the helper's bearer, not rotate it")
	}
	if !ValidateGitCredentialExchange(cfg.WorkspaceID, token) {
		t.Fatal("the running container's bearer must validate again")
	}
}

// Bearers are per workspace: reusing one workspace's helper path content for
// another workspace is never accepted.
func TestExchangeBearerDoesNotAuthenticateAnotherWorkspace(t *testing.T) {
	a := newExchangeTestConfig(t)
	b := newExchangeTestConfig(t)
	b.WorkspaceID += "-b"
	t.Cleanup(func() { _ = RemoveCredentialHelperFromHost(b.WorkspaceID) })

	_, scriptA, _ := mustWriteHostHelper(t, a)
	_, scriptB, _ := mustWriteHostHelper(t, b)
	tokenA := ExchangeTokenFromHelperScript(scriptA)
	if ValidateGitCredentialExchange(b.WorkspaceID, tokenA) {
		t.Fatal("workspace A's bearer authenticated as workspace B")
	}
	if !ValidateGitCredentialExchange(b.WorkspaceID, ExchangeTokenFromHelperScript(scriptB)) {
		t.Fatal("owner control: workspace B's own bearer must validate")
	}
}

func TestCleanupAfterFailedPrepare(t *testing.T) {
	notRunning := fmt.Errorf("%w (label: k=v)", container.ErrNoRunningDevcontainer)
	cases := []struct {
		name       string
		minted     bool
		lookup     func(context.Context, *config.Config) (string, error)
		wantKept   bool
		wantLookup bool
	}{
		{name: "reused bearer is kept without a lookup", minted: false, wantKept: true},
		{
			name: "minted bearer under a running container is kept", minted: true, wantKept: true, wantLookup: true,
			lookup: func(context.Context, *config.Config) (string, error) { return "container-1", nil },
		},
		{
			name: "minted bearer is kept when docker cannot be queried", minted: true, wantKept: true, wantLookup: true,
			lookup: func(context.Context, *config.Config) (string, error) {
				return "", errors.New("failed to query docker: daemon unavailable")
			},
		},
		{
			name: "minted bearer with no running container is removed", minted: true, wantKept: false, wantLookup: true,
			lookup: func(context.Context, *config.Config) (string, error) { return "", notRunning },
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runCleanupCase(t, tc.minted, tc.lookup, tc.wantLookup, tc.wantKept)
		})
	}
}

func runCleanupCase(t *testing.T, minted bool, lookup func(context.Context, *config.Config) (string, error), wantLookup, wantKept bool) {
	t.Helper()
	cfg := newExchangeTestConfig(t)
	hostPath, script, _ := mustWriteHostHelper(t, cfg)

	looked := false
	original := findRunningDevcontainerForCleanup
	t.Cleanup(func() { findRunningDevcontainerForCleanup = original })
	findRunningDevcontainerForCleanup = func(ctx context.Context, c *config.Config) (string, error) {
		looked = true
		if lookup == nil {
			t.Fatal("unexpected container lookup")
		}
		return lookup(ctx, c)
	}

	cleanupCredentialHelperAfterFailedPrepare(cfg, minted)

	if looked != wantLookup {
		t.Fatalf("container lookup = %v, want %v", looked, wantLookup)
	}
	_, statErr := os.Stat(hostPath)
	kept := statErr == nil
	valid := ValidateGitCredentialExchange(cfg.WorkspaceID, ExchangeTokenFromHelperScript(script))
	if kept != wantKept || valid != wantKept {
		t.Fatalf("helper kept=%v digest valid=%v, want both %v", kept, valid, wantKept)
	}
}

func TestInContainerHelperAccepted(t *testing.T) {
	cfg := newExchangeTestConfig(t)
	_, current, _ := mustWriteHostHelper(t, cfg)

	cases := []struct {
		name    string
		content string
		present bool
		want    bool
	}{
		{name: "current helper", content: current, present: true, want: true},
		{name: "pre-bearer agent helper", content: "#!/bin/sh\ncurl -fsS http://host/git-credential\n", present: true, want: false},
		{name: "stale bearer", content: "#!/bin/sh\nexchange_token='rotated-away'\n", present: true, want: false},
		{name: "no helper", present: false, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			original := readInContainerHelper
			t.Cleanup(func() { readInContainerHelper = original })
			readInContainerHelper = func(context.Context, string, string) (string, bool) {
				return tc.content, tc.present
			}
			if got := inContainerHelperAccepted(context.Background(), cfg, "container-1", credentialHelperContainerPath); got != tc.want {
				t.Fatalf("inContainerHelperAccepted = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestExchangeTokenFromHelperScript(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"#!/bin/sh\nexchange_token='abc_DEF-123'\n":                    "abc_DEF-123",
		"#!/bin/sh\n  exchange_token='indented'\n":                     "indented",
		"#!/bin/sh\necho hi\n":                                         "",
		"#!/bin/sh\nexchange_token=''\n":                               "",
		"#!/bin/sh\nexchange_token='$(evil)'\n":                        "",
		"#!/bin/sh\nexchange_token='a b'\n":                            "",
		"#!/bin/sh\nexchange_token=unquoted-token\n":                   "unquoted-token",
		"#!/bin/sh\nexchange_token='first'\nexchange_token='second'\n": "first",
	}
	for script, want := range cases {
		if got := ExchangeTokenFromHelperScript(script); got != want {
			t.Errorf("ExchangeTokenFromHelperScript(%q) = %q, want %q", script, got, want)
		}
	}
}
