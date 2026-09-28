package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/config"
)

// standaloneCredentialExchange is the credential path of an Instant workspace
// with only the network faked: the production-rendered credential helper, the
// real vm-agent /git-credential handler, and a fake control plane that mints
// GitHub tokens the way POST /api/workspaces/:id/git-token does.
type standaloneCredentialExchange struct {
	workspaceID string
	endpoint    string
	helperPath  string
	mintCalls   atomic.Int32

	mu        sync.Mutex
	lastQuery url.Values
}

// newStandaloneCredentialExchange starts the exchange. A mintStatus other than
// 200 makes the control plane refuse, as it does for a revoked installation or
// a GitHub CLI policy that forbids minting.
func newStandaloneCredentialExchange(t *testing.T, workspaceID string, mintStatus int, mintedToken string) *standaloneCredentialExchange {
	t.Helper()
	exchange := &standaloneCredentialExchange{workspaceID: workspaceID}

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exchange.mintCalls.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/api/workspaces/"+workspaceID+"/git-token" {
			t.Errorf("unexpected control plane request: %s %s", r.Method, r.URL.Path)
		}
		if mintStatus != http.StatusOK {
			w.WriteHeader(mintStatus)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"token":%q,"expiresAt":"2099-01-01T00:00:00Z"}`, mintedToken)
	}))
	t.Cleanup(controlPlane.Close)

	agent := &Server{config: &config.Config{
		ControlPlaneURL: controlPlane.URL,
		WorkspaceID:     workspaceID,
		CallbackToken:   "callback-token",
	}}
	vmAgent := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		exchange.mu.Lock()
		exchange.lastQuery = r.URL.Query()
		exchange.mu.Unlock()
		agent.handleGitCredential(w, r)
	}))
	t.Cleanup(vmAgent.Close)
	exchange.endpoint = vmAgent.URL + "/git-credential"

	exchange.helperPath = filepath.Join(t.TempDir(), "git-credential-sam")
	if err := writeStandaloneGitCredentialHelper(exchange.helperPath, 5*time.Second); err != nil {
		t.Fatalf("write credential helper: %v", err)
	}
	return exchange
}

// agentEnv is the environment of an Instant agent shell: the workspace identity
// from SAMEnvFallback, the GH_TOKEN injected when the session started, and the
// exchange endpoint standing in for the vm-agent's loopback port.
func (e *standaloneCredentialExchange) agentEnv(sessionGHToken string) []string {
	return hermeticEnv(
		"SAM_WORKSPACE_ID="+e.workspaceID,
		"SAM_GIT_CREDENTIAL_ENDPOINT="+e.endpoint,
		"GH_TOKEN="+sessionGHToken,
	)
}

func (e *standaloneCredentialExchange) lastRequestQuery() url.Values {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.lastQuery
}

// hermeticEnv returns the test process environment without anything that could
// reach a real credential source, followed by the overrides. A SAM workspace
// running these tests exports SAM_WORKSPACE_ID and GH_TOKEN, and injects its own
// credential helper through GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n,
// which git consults before any helper a test configures.
func hermeticEnv(overrides ...string) []string {
	scrubbed := []string{"SAM_WORKSPACE_ID", "SAM_GIT_CREDENTIAL_ENDPOINT", "VM_AGENT_PORT", "GH_TOKEN", "GITHUB_TOKEN", "SSH_ASKPASS"}
	env := make([]string, 0, len(os.Environ())+len(overrides))
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "GIT_") && !slices.Contains(scrubbed, key) {
			env = append(env, entry)
		}
	}
	return slices.Clip(append(env, overrides...))
}
