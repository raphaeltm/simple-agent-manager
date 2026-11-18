package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/workspace/vm-agent/internal/bootstrap"
	"github.com/workspace/vm-agent/internal/config"
)

func TestHostedArtifactsCredentialPorts(t *testing.T) {
	for _, mode := range []string{"vm", "standalone"} {
		for _, tc := range []struct {
			name, bound, request, resolved string
			status, calls                  int
		}{
			{"default", "api.sam.example", "api.sam.example", "api.sam.example", 200, 1},
			{"explicit", "api.sam.example", "api.sam.example:443", "api.sam.example", 200, 1},
			{"padded", "api.sam.example", "api.sam.example:0443", "api.sam.example", 200, 1},
			{"empty port", "api.sam.example", "api.sam.example:", "api.sam.example", 200, 1},
			{"padded custom", "api.sam.example:8443", "api.sam.example:08443", "api.sam.example:8443", 200, 1},
			{"unbound", "api.sam.example", "evil.example:443", "api.sam.example", 204, 0},
			{"wrong custom", "api.sam.example:8443", "api.sam.example:443", "api.sam.example:8443", 204, 0},
			{"response mismatch", "api.sam.example", "api.sam.example:443", "evil.example", 204, 1},
		} {
			t.Run(mode+"/"+tc.name, func(t *testing.T) {
				assertHostedArtifactsCredentialPort(t, mode, "https", tc.bound, tc.request, tc.resolved, hostedCredentialExpectation{tc.status, tc.calls})
			})
		}
	}
}

func TestHostedArtifactsCredentialProtocols(t *testing.T) {
	for _, mode := range []string{"vm", "standalone", "standalone response"} {
		for _, protocol := range []string{"http", "", "https"} {
			t.Run(mode+"/"+protocol, func(t *testing.T) {
				status, calls := 204, 0
				if mode == "standalone response" {
					calls = 1
				}
				if protocol == "https" {
					status, calls = 200, 1
				}
				assertHostedArtifactsCredentialPort(t, mode, protocol, "api.sam.example", "api.sam.example", "api.sam.example", hostedCredentialExpectation{status, calls})
			})
		}
	}
}

type hostedCredentialExpectation struct {
	status, calls int
}

func assertHostedArtifactsCredentialPort(t *testing.T, mode, protocol, bound, requested, resolved string, expected hostedCredentialExpectation) {
	t.Helper()
	var fetched atomic.Int32
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetched.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/api/workspaces/ws-ports/git-token" || r.Header.Get("Authorization") != "Bearer callback" {
			t.Error("incorrect authenticated git-token callback")
		}
		// Match the production Artifacts callback: cloneUrl and username, no
		// provider discriminator. GitLab supplies an explicit provider instead.
		_ = json.NewEncoder(w).Encode(gitTokenResponse{Token: "hosted-token", CloneURL: "https://" + resolved + "/git/repo.git", Username: "x"})
	}))
	defer control.Close()
	s := &Server{config: &config.Config{ControlPlaneURL: control.URL, WorkspaceID: "ws-ports", CallbackToken: "callback", RepoProvider: "artifacts", RepositoryHost: bound}}
	if mode == "vm" {
		// The node config deliberately disagrees: VM exchanges must use the workspace binding.
		s.config.WorkspaceID = "node"
		s.config.RepositoryHost = "other.example"
		s.workspaces = map[string]*WorkspaceRuntime{"ws-ports": {ID: "ws-ports", RepoProvider: "artifacts", RepositoryHost: bound, CallbackToken: "callback"}}
	} else {
		s.config.Role = config.RoleStandalone
		if mode == "standalone response" {
			// Legacy/absent local provider metadata must not bypass the resolved
			// Artifacts credential's response-side HTTPS requirement.
			s.config.RepoProvider = ""
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-ports&protocol="+url.QueryEscape(protocol)+"&host="+url.QueryEscape(requested), nil)
	req.Header.Set("Authorization", "Bearer callback")
	rec := httptest.NewRecorder()
	if mode != "vm" {
		code, output := fillHostedStandaloneCredential(t, s, requested, protocol)
		rec.Code = code
		_, _ = rec.Body.WriteString(output)
	} else {
		s.handleGitCredential(rec, req)
	}
	if rec.Code != expected.status || int(fetched.Load()) != expected.calls {
		t.Fatalf("status %d, callback calls %d; want %d/%d", rec.Code, fetched.Load(), expected.status, expected.calls)
	}
	if expected.status == http.StatusOK {
		if !strings.Contains(rec.Body.String(), "username=x\npassword=hosted-token\n") {
			t.Fatal("matching authority did not receive the resolved credential")
		}
	} else if rec.Body.Len() != 0 {
		t.Fatal("refused authority received credential output")
	}
}

// Enter the standalone exchange the way a subsequent fetch/push does: Git calls
// the production shell helper, which authenticates to the real local handler.
func fillHostedStandaloneCredential(t *testing.T, agent *Server, host, protocol string) (int, string) {
	t.Helper()
	const workspace = "ws-ports"
	lockStandaloneExchange(t, workspace)
	if err := bootstrap.InstallGitCredentialExchange(workspace, testStandaloneGitCredentialExchangeToken); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bootstrap.RemoveCredentialHelperFromHost(workspace) })
	var code atomic.Int32
	local := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := httptest.NewRecorder()
		agent.handleGitCredential(rec, r)
		code.Store(int32(rec.Code))
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
	}))
	defer local.Close()
	helper := filepath.Join(t.TempDir(), "helper")
	if err := writeStandaloneGitCredentialHelper(helper, time.Second, testStandaloneGitCredentialExchangeToken); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("git", "-c", "credential.helper="+helper, "-c", "credential.useHttpPath=true", "credential", "fill")
	if protocol == "" {
		// Git refuses an absent protocol before invoking helpers; drive the real
		// helper directly to verify the exchange also refuses that input.
		cmd = exec.Command(helper, "get")
	}
	cmd.Env = hermeticEnv("SAM_WORKSPACE_ID="+workspace, "SAM_GIT_CREDENTIAL_ENDPOINT="+local.URL+"/git-credential", "HOME="+t.TempDir(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0")
	cmd.Stdin = strings.NewReader("protocol=" + protocol + "\nhost=" + host + "\npath=git/repo.git\n\n")
	output, err := cmd.Output()
	if protocol != "" && (code.Load() == http.StatusOK) != (err == nil) {
		t.Fatalf("Git credential fill success disagrees with the exchange status %d", code.Load())
	}
	return int(code.Load()), string(output)
}
