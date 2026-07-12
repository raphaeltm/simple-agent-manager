package server

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

func TestHandleGitCredentialRequiresCallbackAuth(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{
			CallbackToken: "callback-token",
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential", nil)
	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func TestHandleGitCredentialSuccess(t *testing.T) {
	t.Parallel()

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST method, got %s", r.Method)
		}
		if r.URL.Path != "/api/workspaces/ws-123/git-token" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer callback-token" {
			t.Fatalf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_test_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			WorkspaceID:     "ws-123",
			CallbackToken:   "callback-token",
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential", nil)
	req.Header.Set("Authorization", "Bearer callback-token")

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	got := rec.Body.String()
	want := "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_test_token\n\n"
	if got != want {
		t.Fatalf("unexpected body:\n%s\nwant:\n%s", got, want)
	}
}

func TestHandleGitCredentialRespectsRequestedHostProvider(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		queryHost  string
		tokenBody  string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "artifacts token for github query is empty",
			queryHost:  "github.com",
			tokenBody:  `{"token":"art_token","expiresAt":"2026-01-01T00:00:00Z","cloneUrl":"https://x:art_token@acct.artifacts.cloudflare.net/git/default/repo.git"}`,
			wantStatus: http.StatusNoContent,
		},
		{
			name:       "artifacts token for matching artifacts query returns credential",
			queryHost:  "acct.artifacts.cloudflare.net",
			tokenBody:  `{"token":"art_token","expiresAt":"2026-01-01T00:00:00Z","cloneUrl":"https://x:art_token@acct.artifacts.cloudflare.net/git/default/repo.git"}`,
			wantStatus: http.StatusOK,
			wantBody:   "protocol=https\nhost=acct.artifacts.cloudflare.net\nusername=x\npassword=art_token\n\n",
		},
		{
			name:       "github token for github query returns credential",
			queryHost:  "github.com",
			tokenBody:  `{"token":"ghs_test_token","expiresAt":"2026-01-01T00:00:00Z"}`,
			wantStatus: http.StatusOK,
			wantBody:   "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_test_token\n\n",
		},
		{
			name:       "github token for artifacts query is empty",
			queryHost:  "acct.artifacts.cloudflare.net",
			tokenBody:  `{"token":"ghs_test_token","expiresAt":"2026-01-01T00:00:00Z"}`,
			wantStatus: http.StatusNoContent,
		},
		{
			name:       "unknown requested host is empty without token fetch",
			queryHost:  "gitlab.com",
			tokenBody:  `{"token":"should_not_be_used","expiresAt":"2026-01-01T00:00:00Z"}`,
			wantStatus: http.StatusNoContent,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var controlPlaneCalls atomic.Int32
			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				controlPlaneCalls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.tokenBody))
			}))
			defer controlPlane.Close()

			s := &Server{
				config: &config.Config{
					ControlPlaneURL: controlPlane.URL,
					WorkspaceID:     "ws-123",
					CallbackToken:   "callback-token",
				},
			}

			req := httptest.NewRequest(http.MethodGet, "/git-credential?host="+tc.queryHost, nil)
			req.Header.Set("Authorization", "Bearer callback-token")

			rec := httptest.NewRecorder()
			s.handleGitCredential(rec, req)

			if rec.Code != tc.wantStatus {
				t.Fatalf("expected status %d, got %d: %s", tc.wantStatus, rec.Code, rec.Body.String())
			}
			if rec.Body.String() != tc.wantBody {
				t.Fatalf("unexpected body:\n%s\nwant:\n%s", rec.Body.String(), tc.wantBody)
			}
			if tc.queryHost == "gitlab.com" && controlPlaneCalls.Load() != 0 {
				t.Fatalf("unknown host should not fetch token, got %d calls", controlPlaneCalls.Load())
			}
		})
	}
}

func TestHandleGitCredentialGitLabRespectsRequestedPath(t *testing.T) {
	t.Parallel()

	var controlPlaneCalls atomic.Int32
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		controlPlaneCalls.Add(1)
		if r.URL.Path != "/api/workspaces/ws-gitlab/git-token" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer gitlab-callback-token" {
			t.Fatalf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"provider":"gitlab",
			"token":"gl_token",
			"expiresAt":null,
			"cloneUrl":"https://gitlab.com/group/project.git",
			"host":"gitlab.com",
			"username":"oauth2",
			"repositoryPath":"group/project"
		}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			WorkspaceID:     "ws-gitlab",
			CallbackToken:   "gitlab-callback-token",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-gitlab": {
				ID:             "ws-gitlab",
				CallbackToken:  "gitlab-callback-token",
				RepoProvider:   "gitlab",
				RepositoryHost: "gitlab.com",
				RepositoryPath: "group/project",
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-gitlab&host=gitlab.com&path=group/project.git", nil)
	req.Header.Set("Authorization", "Bearer gitlab-callback-token")

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	want := "protocol=https\nhost=gitlab.com\nusername=oauth2\npassword=gl_token\n\n"
	if rec.Body.String() != want {
		t.Fatalf("unexpected body:\n%s\nwant:\n%s", rec.Body.String(), want)
	}

	wrongPathReq := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-gitlab&host=gitlab.com&path=other/project.git", nil)
	wrongPathReq.Header.Set("Authorization", "Bearer gitlab-callback-token")

	wrongPathRec := httptest.NewRecorder()
	s.handleGitCredential(wrongPathRec, wrongPathReq)

	if wrongPathRec.Code != http.StatusNoContent {
		t.Fatalf("expected 204 for wrong path, got %d: %s", wrongPathRec.Code, wrongPathRec.Body.String())
	}
	if controlPlaneCalls.Load() != 1 {
		t.Fatalf("wrong path should not fetch a second token, got %d calls", controlPlaneCalls.Load())
	}
}

func TestIsAllowedCredentialPathForWorkspaceFallsBackToConfig(t *testing.T) {
	t.Parallel()

	// Standalone / unregistered-workspace mode: the workspace is not in the
	// runtime map, so the gate must enforce the process config's GitLab path
	// binding rather than failing open.
	gitlab := &Server{
		config: &config.Config{
			RepoProvider:   "gitlab",
			RepositoryPath: "group/project",
		},
		workspaces: map[string]*WorkspaceRuntime{},
	}
	if !gitlab.isAllowedCredentialPathForWorkspace("ws-unknown", "group/project.git") {
		t.Fatal("matching path against config binding should be allowed")
	}
	if gitlab.isAllowedCredentialPathForWorkspace("ws-unknown", "other/project.git") {
		t.Fatal("mismatched path must be blocked via config fallback, not fail open")
	}

	// Non-GitLab config: path gating does not apply (GitHub/Artifacts credentials
	// are host-scoped), so any requested path is permitted.
	github := &Server{
		config:     &config.Config{RepoProvider: "github"},
		workspaces: map[string]*WorkspaceRuntime{},
	}
	if !github.isAllowedCredentialPathForWorkspace("ws-unknown", "any/path.git") {
		t.Fatal("non-gitlab config should not gate on path")
	}

	// A registered runtime takes precedence over the process config.
	scoped := &Server{
		config: &config.Config{RepoProvider: "gitlab", RepositoryPath: "config/path"},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-a": {ID: "ws-a", RepoProvider: "gitlab", RepositoryPath: "runtime/path"},
		},
	}
	if !scoped.isAllowedCredentialPathForWorkspace("ws-a", "runtime/path.git") {
		t.Fatal("runtime binding path should be allowed")
	}
	if scoped.isAllowedCredentialPathForWorkspace("ws-a", "config/path.git") {
		t.Fatal("runtime binding must override the config fallback")
	}

	// Fail-closed: a gitlab-bound workspace whose bound repository path is
	// empty (misconfiguration) must refuse every requested path — never fall
	// open to "any path allowed".
	emptyRuntime := &Server{
		config: &config.Config{RepoProvider: "gitlab", RepositoryPath: "config/path"},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-empty": {ID: "ws-empty", RepoProvider: "gitlab", RepositoryPath: ""},
		},
	}
	if emptyRuntime.isAllowedCredentialPathForWorkspace("ws-empty", "group/project.git") {
		t.Fatal("gitlab runtime with empty bound path must fail closed")
	}
	emptyConfig := &Server{
		config:     &config.Config{RepoProvider: "gitlab", RepositoryPath: ""},
		workspaces: map[string]*WorkspaceRuntime{},
	}
	if emptyConfig.isAllowedCredentialPathForWorkspace("ws-unknown", "group/project.git") {
		t.Fatal("gitlab config fallback with empty bound path must fail closed")
	}
}

// TestHandleGitCredentialGitLabFailClosedWithoutHostOrPath verifies the
// request-side fail-closed gate: a gitlab-bound workspace must supply BOTH
// host and path or the exchange returns 204 without ever contacting the
// control plane. GitHub/Artifacts keep the empty-allow behavior (covered by
// TestHandleGitCredentialSuccess).
func TestHandleGitCredentialGitLabFailClosedWithoutHostOrPath(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		query string
	}{
		{name: "no host and no path", query: ""},
		{name: "host without path", query: "&host=gitlab.com"},
		{name: "path without host", query: "&path=group/project.git"},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			var controlPlaneCalls atomic.Int32
			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				controlPlaneCalls.Add(1)
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"provider":"gitlab","token":"gl_token","expiresAt":null,"host":"gitlab.com","username":"oauth2","repositoryPath":"group/project"}`))
			}))
			defer controlPlane.Close()

			s := &Server{
				config: &config.Config{
					ControlPlaneURL: controlPlane.URL,
					WorkspaceID:     "ws-gitlab",
					CallbackToken:   "gitlab-callback-token",
				},
				workspaces: map[string]*WorkspaceRuntime{
					"ws-gitlab": {
						ID:             "ws-gitlab",
						CallbackToken:  "gitlab-callback-token",
						RepoProvider:   "gitlab",
						RepositoryHost: "gitlab.com",
						RepositoryPath: "group/project",
					},
				},
			}

			req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-gitlab"+tc.query, nil)
			req.Header.Set("Authorization", "Bearer gitlab-callback-token")

			rec := httptest.NewRecorder()
			s.handleGitCredential(rec, req)

			if rec.Code != http.StatusNoContent {
				t.Fatalf("expected 204, got %d: %s", rec.Code, rec.Body.String())
			}
			if rec.Body.Len() != 0 {
				t.Fatalf("expected empty body, got: %s", rec.Body.String())
			}
			if controlPlaneCalls.Load() != 0 {
				t.Fatalf("gitlab-bound exchange without host+path must not fetch a token, got %d calls", controlPlaneCalls.Load())
			}
		})
	}
}

// TestHandleGitCredentialGitLabResponseFailClosed verifies the response-side
// gate: even when the local binding did NOT identify the workspace as gitlab
// (e.g. unregistered runtime falling back to a github process config), a
// control-plane response with provider=gitlab is only released when the caller
// supplied a host and path and the resolved repositoryPath is verifiable.
func TestHandleGitCredentialGitLabResponseFailClosed(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name      string
		query     string
		tokenBody string
	}{
		{
			// Local binding says github (no prefetch gitlab gate), but the control
			// plane resolves a gitlab credential — must not be released without
			// host+path identification.
			name:      "gitlab response without requested host and path",
			query:     "",
			tokenBody: `{"provider":"gitlab","token":"gl_token","expiresAt":null,"host":"gitlab.com","username":"oauth2","repositoryPath":"group/project"}`,
		},
		{
			// Host+path supplied but the control plane response carries no
			// repositoryPath — the binding cannot be verified, so refuse.
			name:      "gitlab response without resolved repository path",
			query:     "&host=gitlab.com&path=group/project.git",
			tokenBody: `{"provider":"gitlab","token":"gl_token","expiresAt":null,"host":"gitlab.com","username":"oauth2"}`,
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.tokenBody))
			}))
			defer controlPlane.Close()

			s := &Server{
				config: &config.Config{
					ControlPlaneURL: controlPlane.URL,
					WorkspaceID:     "ws-mislabeled",
					CallbackToken:   "callback-token",
					RepoProvider:    "github",
					RepositoryHost:  "gitlab.com",
				},
				workspaces: map[string]*WorkspaceRuntime{},
			}

			req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-mislabeled"+tc.query, nil)
			req.Header.Set("Authorization", "Bearer callback-token")

			rec := httptest.NewRecorder()
			s.handleGitCredential(rec, req)

			if rec.Code != http.StatusNoContent {
				t.Fatalf("expected 204, got %d: %s", rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "gl_token") {
				t.Fatal("gitlab token must not be released without verified host and path")
			}
		})
	}
}

func TestTryCreateGitLabMergeRequestUsesWorkspaceToken(t *testing.T) {
	t.Parallel()

	var sawTokenRequest atomic.Bool
	var sawMergeRequest atomic.Bool
	api := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/workspaces/ws-gitlab/git-token":
			sawTokenRequest.Store(true)
			if r.Method != http.MethodPost {
				t.Fatalf("expected token POST, got %s", r.Method)
			}
			if r.Header.Get("Authorization") != "Bearer gitlab-callback-token" {
				t.Fatalf("unexpected token Authorization header: %q", r.Header.Get("Authorization"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"provider":"gitlab","token":"gl_token","expiresAt":null}`))
		case strings.Contains(r.RequestURI, "/api/v4/projects/group%2Fproject/merge_requests"):
			sawMergeRequest.Store(true)
			if r.Method != http.MethodPost {
				t.Fatalf("expected MR POST, got %s", r.Method)
			}
			if r.Header.Get("Authorization") != "Bearer gl_token" {
				t.Fatalf("unexpected MR Authorization header: %q", r.Header.Get("Authorization"))
			}
			if err := r.ParseForm(); err != nil {
				t.Fatalf("parse MR form: %v", err)
			}
			if r.Form.Get("source_branch") != "sam/feature" {
				t.Fatalf("unexpected source_branch: %q", r.Form.Get("source_branch"))
			}
			if r.Form.Get("target_branch") != "main" {
				t.Fatalf("unexpected target_branch: %q", r.Form.Get("target_branch"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"web_url":"https://gitlab.example/group/project/-/merge_requests/7","iid":7}`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.RequestURI)
		}
	}))
	defer api.Close()

	host := strings.TrimPrefix(api.URL, "https://")
	s := &Server{
		config: &config.Config{
			ControlPlaneURL: api.URL,
		},
		httpClient: api.Client(),
		workspaces: map[string]*WorkspaceRuntime{
			"ws-gitlab": {
				ID:            "ws-gitlab",
				CallbackToken: "gitlab-callback-token",
			},
		},
	}
	runtime := &WorkspaceRuntime{
		ID:             "ws-gitlab",
		Branch:         "main",
		RepoProvider:   "gitlab",
		RepositoryHost: host,
		RepositoryPath: "group/project",
	}

	mrURL, iid := s.tryCreateGitLabMergeRequest(runtime, "sam/feature")

	if mrURL != "https://gitlab.example/group/project/-/merge_requests/7" {
		t.Fatalf("unexpected MR URL: %q", mrURL)
	}
	if iid != 7 {
		t.Fatalf("unexpected MR iid: %d", iid)
	}
	if !sawTokenRequest.Load() {
		t.Fatal("expected token request")
	}
	if !sawMergeRequest.Load() {
		t.Fatal("expected merge request")
	}
}

// TestTryCreateGitLabMergeRequestFallsBackToExistingOn409 verifies that when
// GitLab rejects the MR create with 409 (an MR already exists for the source
// branch), the agent looks up the existing open MR and returns its URL/IID
// instead of reporting a failure.
func TestTryCreateGitLabMergeRequestFallsBackToExistingOn409(t *testing.T) {
	t.Parallel()

	var sawCreateAttempt atomic.Bool
	var sawLookup atomic.Bool
	api := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/workspaces/ws-gitlab/git-token":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"provider":"gitlab","token":"gl_token","expiresAt":null}`))
		case strings.Contains(r.RequestURI, "/api/v4/projects/group%2Fproject/merge_requests") && r.Method == http.MethodPost:
			sawCreateAttempt.Store(true)
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"message":["Another open merge request already exists for this source branch"]}`))
		case strings.Contains(r.RequestURI, "/api/v4/projects/group%2Fproject/merge_requests") && r.Method == http.MethodGet:
			sawLookup.Store(true)
			if r.Header.Get("Authorization") != "Bearer gl_token" {
				t.Fatalf("unexpected lookup Authorization header: %q", r.Header.Get("Authorization"))
			}
			q := r.URL.Query()
			if q.Get("state") != "opened" {
				t.Fatalf("unexpected state param: %q", q.Get("state"))
			}
			if q.Get("source_branch") != "sam/feature" {
				t.Fatalf("unexpected source_branch param: %q", q.Get("source_branch"))
			}
			if q.Get("target_branch") != "main" {
				t.Fatalf("unexpected target_branch param: %q", q.Get("target_branch"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"web_url":"https://gitlab.example/group/project/-/merge_requests/9","iid":9}]`))
		default:
			t.Fatalf("unexpected request: %s %s", r.Method, r.RequestURI)
		}
	}))
	defer api.Close()

	host := strings.TrimPrefix(api.URL, "https://")
	s := &Server{
		config: &config.Config{
			ControlPlaneURL: api.URL,
		},
		httpClient: api.Client(),
		workspaces: map[string]*WorkspaceRuntime{
			"ws-gitlab": {
				ID:            "ws-gitlab",
				CallbackToken: "gitlab-callback-token",
			},
		},
	}
	runtime := &WorkspaceRuntime{
		ID:             "ws-gitlab",
		Branch:         "main",
		RepoProvider:   "gitlab",
		RepositoryHost: host,
		RepositoryPath: "group/project",
	}

	mrURL, iid := s.tryCreateGitLabMergeRequest(runtime, "sam/feature")

	if mrURL != "https://gitlab.example/group/project/-/merge_requests/9" {
		t.Fatalf("unexpected MR URL: %q", mrURL)
	}
	if iid != 9 {
		t.Fatalf("unexpected MR iid: %d", iid)
	}
	if !sawCreateAttempt.Load() {
		t.Fatal("expected MR create attempt")
	}
	if !sawLookup.Load() {
		t.Fatal("expected existing-MR lookup after 409")
	}
}

func TestHandleGitCredentialAllowsLocalExchangeWithoutCallbackBearer(t *testing.T) {
	t.Parallel()

	var requestedAuth string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_test_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			WorkspaceID:     "ws-123",
			CallbackToken:   "callback-token",
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential", nil)
	req.RemoteAddr = "172.17.0.2:52144"

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if requestedAuth != "Bearer callback-token" {
		t.Fatalf("expected VM agent to use in-memory callback token, got %q", requestedAuth)
	}
	if got := rec.Body.String(); !strings.Contains(got, "password=ghs_test_token") {
		t.Fatalf("expected credential response, got:\n%s", got)
	}
}

// TestHandleGitCredentialAllowsLocalExchangeForRegisteredSecondaryWorkspace
// verifies that a bearerless loopback request for a SECONDARY workspace that is
// registered in the runtime map is authorized and exchanges using that
// workspace's own callback token. All workspaces running on the node are treated
// equally — there is no longer a primary-only gate.
func TestHandleGitCredentialAllowsLocalExchangeForRegisteredSecondaryWorkspace(t *testing.T) {
	t.Parallel()

	var requestedPath string
	var requestedAuth string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		requestedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_secondary_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := newTwoWorkspaceGitCredentialServer(controlPlane.URL)

	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-secondary", nil)
	req.RemoteAddr = "172.17.0.2:52144"

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if requestedPath != "/api/workspaces/ws-secondary/git-token" {
		t.Fatalf("expected exchange for ws-secondary, got path %q", requestedPath)
	}
	if requestedAuth != "Bearer secondary-callback-token" {
		t.Fatalf("expected secondary workspace callback token, got %q", requestedAuth)
	}
	if got := rec.Body.String(); !strings.Contains(got, "password=ghs_secondary_token") {
		t.Fatalf("expected credential response, got:\n%s", got)
	}
}

// TestHandleGitCredentialRejectsLocalExchangeForUnregisteredWorkspace verifies
// that a bearerless loopback request for a workspace id that is NOT registered
// on the node (not primary, not in the runtime map) is rejected with 401 and
// never reaches the control plane.
func TestHandleGitCredentialRejectsLocalExchangeForUnregisteredWorkspace(t *testing.T) {
	t.Parallel()

	var controlPlaneCalled atomic.Bool
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		controlPlaneCalled.Store(true)
		w.WriteHeader(http.StatusOK)
	}))
	defer controlPlane.Close()

	s := newTwoWorkspaceGitCredentialServer(controlPlane.URL)

	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-unknown", nil)
	req.RemoteAddr = "172.17.0.2:52144"

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if controlPlaneCalled.Load() {
		t.Fatal("control plane should not be called for an unregistered workspace")
	}
}

func TestHandleGitCredentialAllowsBearerForNonPrimaryWorkspace(t *testing.T) {
	t.Parallel()

	var requestedAuth string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_secondary_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := newTwoWorkspaceGitCredentialServer(controlPlane.URL)

	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-secondary", nil)
	req.RemoteAddr = "172.17.0.2:52144"
	req.Header.Set("Authorization", "Bearer secondary-callback-token")

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if requestedAuth != "Bearer secondary-callback-token" {
		t.Fatalf("expected control plane to receive secondary callback token, got %q", requestedAuth)
	}
}

func newTwoWorkspaceGitCredentialServer(controlPlaneURL string) *Server {
	return &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlaneURL,
			WorkspaceID:     "ws-primary",
			CallbackToken:   "primary-callback-token",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-secondary": {
				ID:            "ws-secondary",
				CallbackToken: "secondary-callback-token",
			},
		},
	}
}

func TestHandleGitCredentialControlPlaneFailure(t *testing.T) {
	t.Parallel()

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"internal","message":"boom"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			WorkspaceID:     "ws-123",
			CallbackToken:   "callback-token",
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential", nil)
	req.Header.Set("Authorization", "Bearer callback-token")

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Fatalf("expected 502, got %d", rec.Code)
	}

	var payload map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("expected JSON error body, got: %v", err)
	}
	if payload["error"] == "" {
		t.Fatal("expected error message in response body")
	}
}

// TestPerSessionGitTokenFetcherUsesCorrectWorkspaceID verifies that a
// per-session closure built from fetchGitTokenForWorkspace hits the correct
// workspace's git-token endpoint rather than the node-level s.config.WorkspaceID.
// This is the regression test for the GH_TOKEN-empty-in-workspaces bug where
// multi-workspace nodes used the wrong workspace ID.
func TestPerSessionGitTokenFetcherUsesCorrectWorkspaceID(t *testing.T) {
	t.Parallel()

	var requestedPath string
	var requestedAuth string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		requestedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_session_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			// Node-level workspace ID — should NOT be used by per-session fetcher.
			WorkspaceID:   "ws-node-level",
			CallbackToken: "node-callback-token",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-session-123": {
				ID:            "ws-session-123",
				CallbackToken: "session-callback-token",
			},
		},
	}

	// Build the same per-session closure that getOrCreateSessionHost creates.
	sessionWorkspaceID := "ws-session-123"
	fetcher := func() (string, error) {
		return s.fetchGitTokenForWorkspace(t.Context(), sessionWorkspaceID, "")
	}

	token, err := fetcher()
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if token != "ghs_session_token" {
		t.Fatalf("expected ghs_session_token, got %q", token)
	}
	// The request must target the SESSION workspace, not the node-level one.
	wantPath := "/api/workspaces/ws-session-123/git-token"
	if requestedPath != wantPath {
		t.Fatalf("fetcher hit wrong workspace path:\n  got:  %s\n  want: %s", requestedPath, wantPath)
	}
	// It should use the workspace-scoped callback token, not the node-level one.
	if requestedAuth != "Bearer session-callback-token" {
		t.Fatalf("fetcher used wrong callback token:\n  got:  %s\n  want: Bearer session-callback-token", requestedAuth)
	}
}

func TestGitHubTokenFetcherForWorkspaceIsProviderAware(t *testing.T) {
	t.Parallel()

	s := &Server{
		config: &config.Config{
			WorkspaceID: "ws-primary",
			Repository:  "https://github.com/octo/primary.git",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-github": {
				ID:         "ws-github",
				Repository: "https://github.com/octo/secondary.git",
			},
			"ws-artifacts": {
				ID:         "ws-artifacts",
				Repository: "https://acct.artifacts.cloudflare.net/git/default/repo.git",
			},
			"ws-empty": {
				ID: "ws-empty",
			},
		},
	}

	if fetcher := s.gitHubTokenFetcherForWorkspace("ws-primary"); fetcher == nil {
		t.Fatal("primary GitHub workspace should get a GitTokenFetcher")
	}
	if fetcher := s.gitHubTokenFetcherForWorkspace("ws-github"); fetcher == nil {
		t.Fatal("secondary GitHub workspace should get a GitTokenFetcher")
	}
	if fetcher := s.gitHubTokenFetcherForWorkspace("ws-artifacts"); fetcher != nil {
		t.Fatal("Artifacts workspace must not get a GH_TOKEN GitTokenFetcher")
	}
	if fetcher := s.gitHubTokenFetcherForWorkspace("ws-empty"); fetcher != nil {
		t.Fatal("workspace without a GitHub repository must not get a GH_TOKEN GitTokenFetcher")
	}
}

// TestTwoWorkspaceGitTokenIsolation verifies that fetcher closures for two
// different workspaces on the same node use separate workspace IDs and callback
// tokens — the canonical multi-tenant isolation test for the per-session fix.
func TestTwoWorkspaceGitTokenIsolation(t *testing.T) {
	t.Parallel()

	type request struct {
		path string
		auth string
	}
	var mu sync.Mutex
	requests := make(map[string]request) // keyed by workspace ID from path

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		requests[r.URL.Path] = request{path: r.URL.Path, auth: r.Header.Get("Authorization")}
		mu.Unlock()

		// Return a workspace-specific token so callers can verify isolation.
		token := "ghs_unknown"
		if r.URL.Path == "/api/workspaces/ws-alpha/git-token" {
			token = "ghs_alpha_token"
		} else if r.URL.Path == "/api/workspaces/ws-beta/git-token" {
			token = "ghs_beta_token"
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"` + token + `","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			WorkspaceID:     "ws-node-level",
			CallbackToken:   "node-token",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-alpha": {ID: "ws-alpha", CallbackToken: "alpha-callback"},
			"ws-beta":  {ID: "ws-beta", CallbackToken: "beta-callback"},
		},
	}

	// Build per-session closures the same way getOrCreateSessionHost does.
	fetcherAlpha := func() (string, error) {
		return s.fetchGitTokenForWorkspace(t.Context(), "ws-alpha", "")
	}
	fetcherBeta := func() (string, error) {
		return s.fetchGitTokenForWorkspace(t.Context(), "ws-beta", "")
	}

	tokenA, err := fetcherAlpha()
	if err != nil {
		t.Fatalf("alpha fetcher error: %v", err)
	}
	tokenB, err := fetcherBeta()
	if err != nil {
		t.Fatalf("beta fetcher error: %v", err)
	}

	// Verify tokens are workspace-specific (no cross-contamination).
	if tokenA != "ghs_alpha_token" {
		t.Errorf("alpha got wrong token: %q", tokenA)
	}
	if tokenB != "ghs_beta_token" {
		t.Errorf("beta got wrong token: %q", tokenB)
	}

	// Verify each fetcher hit its own workspace endpoint.
	mu.Lock()
	defer mu.Unlock()
	alphaReq := requests["/api/workspaces/ws-alpha/git-token"]
	betaReq := requests["/api/workspaces/ws-beta/git-token"]

	if alphaReq.auth != "Bearer alpha-callback" {
		t.Errorf("alpha used wrong callback token: %q", alphaReq.auth)
	}
	if betaReq.auth != "Bearer beta-callback" {
		t.Errorf("beta used wrong callback token: %q", betaReq.auth)
	}
}

func TestHandleGitCredentialUsesWorkspaceScopedTokenAndWorkspaceID(t *testing.T) {
	t.Parallel()

	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST method, got %s", r.Method)
		}
		if r.URL.Path != "/api/workspaces/ws-abc/git-token" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer workspace-callback-token" {
			t.Fatalf("unexpected Authorization header: %q", r.Header.Get("Authorization"))
		}

		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_workspace_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			CallbackToken:   "node-callback-token",
		},
		workspaces: map[string]*WorkspaceRuntime{
			"ws-abc": {
				ID:            "ws-abc",
				CallbackToken: "workspace-callback-token",
			},
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-abc", nil)
	req.Header.Set("Authorization", "Bearer workspace-callback-token")

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rec.Code)
	}

	got := rec.Body.String()
	want := "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghs_workspace_token\n\n"
	if got != want {
		t.Fatalf("unexpected body:\n%s\nwant:\n%s", got, want)
	}
}

func TestHandleGitCredentialAcceptsValidWorkspaceCallbackJWTWithoutRuntimeToken(t *testing.T) {
	t.Parallel()

	validator, key := testGitCredentialJWTValidator(t)
	workspaceToken := signGitCredentialCallbackToken(t, key, "ws-jwt", time.Now().Add(time.Hour))

	var requestedAuth string
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"token":"ghs_jwt_token","expiresAt":"2026-01-01T00:00:00Z"}`))
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			CallbackToken:   "node-callback-token",
		},
		workspaces:   map[string]*WorkspaceRuntime{},
		jwtValidator: validator,
		workspaceMu:  sync.RWMutex{},
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-jwt", nil)
	req.Header.Set("Authorization", "Bearer "+workspaceToken)

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rec.Code, rec.Body.String())
	}
	if requestedAuth != "Bearer "+workspaceToken {
		t.Fatalf("expected control plane to receive workspace JWT, got %q", requestedAuth)
	}
}

func TestHandleGitCredentialRejectsWrongWorkspaceCallbackJWT(t *testing.T) {
	t.Parallel()

	validator, key := testGitCredentialJWTValidator(t)
	workspaceToken := signGitCredentialCallbackToken(t, key, "ws-other", time.Now().Add(time.Hour))

	controlPlaneCalled := false
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		controlPlaneCalled = true
		w.WriteHeader(http.StatusOK)
	}))
	defer controlPlane.Close()

	s := &Server{
		config: &config.Config{
			ControlPlaneURL: controlPlane.URL,
			CallbackToken:   "node-callback-token",
		},
		workspaces:   map[string]*WorkspaceRuntime{},
		jwtValidator: validator,
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-jwt", nil)
	req.Header.Set("Authorization", "Bearer "+workspaceToken)

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
	if controlPlaneCalled {
		t.Fatal("control plane should not be called for wrong-workspace callback JWT")
	}
}

func TestHandleGitCredentialRejectsExpiredWorkspaceCallbackJWT(t *testing.T) {
	t.Parallel()

	validator, key := testGitCredentialJWTValidator(t)
	workspaceToken := signGitCredentialCallbackToken(t, key, "ws-jwt", time.Now().Add(-time.Minute))

	s := &Server{
		config: &config.Config{
			CallbackToken: "node-callback-token",
		},
		workspaces:   map[string]*WorkspaceRuntime{},
		jwtValidator: validator,
	}

	req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-jwt", nil)
	req.Header.Set("Authorization", "Bearer "+workspaceToken)

	rec := httptest.NewRecorder()
	s.handleGitCredential(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}
}

func testGitCredentialJWTValidator(t *testing.T) (*auth.JWTValidator, *rsa.PrivateKey) {
	t.Helper()

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}

	pubKey := privateKey.Public().(*rsa.PublicKey)
	jwksJSON := buildGitCredentialJWKSJSON(pubKey)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(jwksJSON)
	}))
	t.Cleanup(server.Close)

	validator, err := auth.NewJWTValidator(server.URL, "node-123", "test-issuer", "workspace-terminal")
	if err != nil {
		t.Fatalf("create validator: %v", err)
	}
	t.Cleanup(validator.Close)

	return validator, privateKey
}

func buildGitCredentialJWKSJSON(pub *rsa.PublicKey) []byte {
	n := base64.RawURLEncoding.EncodeToString(pub.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes())
	data, _ := json.Marshal(map[string]any{
		"keys": []map[string]any{{
			"kty": "RSA",
			"alg": "RS256",
			"use": "sig",
			"kid": "test-key-1",
			"n":   n,
			"e":   e,
		}},
	})
	return data
}

func signGitCredentialCallbackToken(
	t *testing.T,
	key *rsa.PrivateKey,
	workspaceID string,
	expiresAt time.Time,
) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "test-issuer",
			Subject:   workspaceID,
			Audience:  jwt.ClaimStrings{"workspace-callback"},
			ExpiresAt: jwt.NewNumericDate(expiresAt),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Workspace: workspaceID,
		Type:      "callback",
		Scope:     "workspace",
	})
	token.Header["kid"] = "test-key-1"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}
