package server

// CI copies this experiment into internal/server only while compiling its test
// binary. It exercises real auth/port/Git handlers with synthetic keys and data.
import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/workspace/vm-agent/internal/auth"
	"github.com/workspace/vm-agent/internal/config"
)

func TestTunnelProofHost(t *testing.T) {
	output := os.Getenv("TUNNEL_PROOF_TOKENS")
	if output == "" {
		t.Skip("standalone live experiment only")
	}
	validator, key := newServerJWTValidator(t, "proof-node")
	tokens := map[string]string{}
	for _, mode := range []string{"valid", "wrong_workspace", "wrong_node", "expired"} {
		workspace, node, expiry := "proof-ws", "proof-node", time.Now().Add(15*time.Minute)
		switch mode {
		case "wrong_workspace":
			workspace = "another-workspace"
		case "wrong_node":
			node = "another-node"
		case "expired":
			expiry = time.Now().Add(-time.Hour)
		}
		claims := auth.Claims{
			RegisteredClaims: jwt.RegisteredClaims{Issuer: "test-issuer", Subject: "fixture-user", Audience: jwt.ClaimStrings{"workspace-terminal"}, ExpiresAt: jwt.NewNumericDate(expiry)},
			Workspace: workspace, Node: node,
		}
		token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
		token.Header["kid"] = "diagnostic-test-key"
		signed, err := token.SignedString(key)
		if err != nil { t.Fatal(err) }
		tokens[mode] = signed
	}
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/proof-ws/git-token" || r.Header.Get("Authorization") != "Bearer fixture-callback" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"token": "synthetic-not-a-github-token", "expiresAt": time.Now().Add(time.Hour).Format(time.RFC3339)})
	}))
	defer controlPlane.Close()
	s := &Server{
		config: &config.Config{WorkspaceID: "proof-ws", NodeID: "proof-node", Port: 9010, ControlPlaneURL: controlPlane.URL, CallbackToken: "fixture-callback"},
		jwtValidator: validator,
		sessionManager: auth.NewSessionManager("proof-session", true, time.Minute),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/workspaces/{workspaceId}/ports/{port}/{path...}", s.handleWorkspacePortProxy)
	mux.HandleFunc("/git-credential", s.handleGitCredential)
	// Model a dedicated tunnel listener: classification is assigned here and
	// cannot be removed by an external caller. The private helper stays separate.
	tunnelHandler := http.StripPrefix("/agent", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		markProxiedRequest(r.Header)
		mux.ServeHTTP(w, r)
	}))
	for _, listener := range []struct{ address string; handler http.Handler }{
		{"127.0.0.1:9010", tunnelHandler}, {"127.0.0.1:9011", mux},
	} {
		ln, err := net.Listen("tcp", listener.address)
		if err != nil { t.Fatal(err) }
		server := &http.Server{Handler: listener.handler, ReadHeaderTimeout: 10*time.Second}
		defer server.Close()
		go func() { _ = server.Serve(ln) }()
	}
	data, err := json.Marshal(tokens)
	if err != nil { t.Fatal(err) }
	if err := os.WriteFile(output, data, 0600); err != nil { t.Fatal(err) }
	// Parent owns process lifecycle; hard stop is a second independent bound.
	time.Sleep(7*time.Minute)
}
