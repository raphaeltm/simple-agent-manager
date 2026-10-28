package server

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/workspace/vm-agent/internal/auth"
)

// Management tokens use sub as the user identity, exactly as the API signer
// does. The workspace callback/local-forward userId payload is not required.
func TestWorkspaceDeletionUsesValidatedManagementSubjectAsOwner(t *testing.T) {
	cases := []struct {
		name, subject, payloadUser string
		want                       int
		authorized                 bool
	}{
		{"API wire without userId payload", "user-1", "", 503, true},
		{"different subject cannot borrow userId payload", "other-owner", "user-1", 409, false},
		{"missing subject cannot borrow userId payload", "", "user-1", 409, false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDeletionFixture(t)
			validator, key := newWorkspaceCreateJWTValidator(t, "node-1")
			fixture.server.jwtValidator = validator
			claims := auth.Claims{RegisteredClaims: jwt.RegisteredClaims{Issuer: "test-issuer", Subject: test.subject, Audience: jwt.ClaimStrings{"node-management"}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour))}, Node: "node-1", Workspace: "workspace-1", UserID: test.payloadUser}
			token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
			token.Header["kid"] = "test-key-1"
			signed, err := token.SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			fixture.token = signed
			response := fixture.request(t.Context(), fixture.identity)
			if response.Code != test.want {
				t.Fatalf("owner authorization response=%d %s", response.Code, response.Body.String())
			}
			payload, err := fixture.server.store.GetWorkspaceDeletion("workspace-1")
			if err != nil {
				t.Fatal(err)
			}
			if test.authorized {
				// Volume failure is deliberately downstream of successful authorization;
				// its persisted intent proves a real API management token reached cleanup.
				if payload == "" {
					t.Fatal("valid API subject did not authorize the durable operation")
				}
				if _, err := os.Stat(filepath.Join(fixture.state, "container")); !os.IsNotExist(err) {
					t.Fatal("valid subject did not reach physical cleanup", err)
				}
			} else {
				if payload != "" {
					t.Fatal("foreign/missing subject acquired deletion authority")
				}
				for _, path := range []string{fixture.root, filepath.Join(fixture.state, "container"), filepath.Join(fixture.state, "volume")} {
					if _, err := os.Stat(path); err != nil {
						t.Fatalf("unauthorized token modified %s: %v", path, err)
					}
				}
			}
		})
	}
}
