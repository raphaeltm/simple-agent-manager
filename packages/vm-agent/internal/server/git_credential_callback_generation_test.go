package server

import (
	"bytes"
	"crypto/rsa"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"

	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

// signGitCredentialGenerationToken signs a valid workspace callback JWT that
// carries callback generation cgen ("" omits the claim).
func signGitCredentialGenerationToken(t *testing.T, key *rsa.PrivateKey, workspaceID, cgen string) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, auth.Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "test-issuer",
			Subject:   workspaceID,
			Audience:  jwt.ClaimStrings{"workspace-callback"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
			IssuedAt:  jwt.NewNumericDate(time.Now()),
		},
		Workspace:          workspaceID,
		Type:               "callback",
		Scope:              "workspace",
		CallbackGeneration: cgen,
	})
	token.Header["kid"] = "test-key-1"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

// The JWT fallback accepts any signature-valid workspace token, so after the
// control plane rotates a workspace's callback generation the previous runtime's
// tokens would keep working here unless the generation is compared.
func TestGitCredentialJWTFallbackRequiresTheCurrentCallbackGeneration(t *testing.T) {
	validator, key := testGitCredentialJWTValidator(t)
	for _, tt := range []struct {
		name, currentGen, presentedGen string
		presentCurrent                 bool
		want                           int
	}{
		{name: "matching generation", currentGen: "gen-b", presentedGen: "gen-b", want: http.StatusOK},
		{name: "previous generation", currentGen: "gen-b", presentedGen: "gen-a", want: http.StatusUnauthorized},
		{name: "absent on both", want: http.StatusOK},
		{name: "presented has generation, current has none", presentedGen: "gen-b", want: http.StatusUnauthorized},
		{name: "presented has none, current has one", currentGen: "gen-b", want: http.StatusUnauthorized},
		{name: "exact current token", currentGen: "gen-b", presentCurrent: true, want: http.StatusOK},
	} {
		t.Run(tt.name, func(t *testing.T) {
			controlPlaneCalled := false
			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				controlPlaneCalled = true
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"token":"ghs_token","expiresAt":"2026-01-01T00:00:00Z"}`))
			}))
			defer controlPlane.Close()

			// The agent's current runtime token is only decoded, never verified here.
			current := generationTestToken(t, "ws-jwt", "workspace", tt.currentGen, time.Hour)
			s := &Server{
				config: &config.Config{
					ControlPlaneURL: controlPlane.URL,
					CallbackToken:   "node-callback-token",
				},
				workspaces:   map[string]*WorkspaceRuntime{"ws-jwt": {ID: "ws-jwt", CallbackToken: current}},
				jwtValidator: validator,
			}
			presented := current
			if !tt.presentCurrent {
				presented = signGitCredentialGenerationToken(t, key, "ws-jwt", tt.presentedGen)
			}

			var logs bytes.Buffer
			previous := slog.Default()
			slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelWarn})))
			defer slog.SetDefault(previous)

			req := httptest.NewRequest(http.MethodGet, "/git-credential?workspaceId=ws-jwt", nil)
			req.Header.Set("Authorization", "Bearer "+presented)
			rec := httptest.NewRecorder()
			s.handleGitCredential(rec, req)

			if rec.Code != tt.want {
				t.Fatalf("status = %d, want %d: %s", rec.Code, tt.want, rec.Body.String())
			}
			if controlPlaneCalled != (tt.want == http.StatusOK) {
				t.Fatalf("control plane called = %v for status %d", controlPlaneCalled, rec.Code)
			}
			if tt.want == http.StatusUnauthorized {
				if !strings.Contains(logs.String(), "reason="+gitCredentialRejectGenerationMismatch) {
					t.Fatalf("rejection not logged as a generation mismatch:\n%s", logs.String())
				}
				for _, secret := range []string{presented, current, "gen-a", "gen-b"} {
					if strings.Contains(logs.String(), secret) {
						t.Fatalf("rejection log leaks a token or generation:\n%s", logs.String())
					}
				}
			}
		})
	}
}
