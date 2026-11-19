package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

// Exercise keyfunc's no-kid lookup through the real SAM validator and an HTTP
// JWKS response. A valid signature must not override a conflicting JWK alg.
func TestJWTValidatorEnforcesJWKAlgorithmWithoutKeyID(t *testing.T) {
	for _, tc := range []struct {
		name    string
		jwkAlg  string
		withKid bool
		wantErr bool
	}{
		{name: "matching algorithm without kid", jwkAlg: "RS256"},
		{name: "mismatched algorithm without kid", jwkAlg: "RS512", wantErr: true},
		{name: "normal keyed token", jwkAlg: "RS256", withKid: true},
		{name: "mismatched algorithm with kid", jwkAlg: "RS512", withKid: true, wantErr: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			key, err := rsa.GenerateKey(rand.Reader, 2048)
			if err != nil {
				t.Fatal(err)
			}
			jwks := strings.Replace(string(buildJWKSJSON(&key.PublicKey)), `"alg":"RS256"`, `"alg":"`+tc.jwkAlg+`"`, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(jwks))
			}))
			t.Cleanup(server.Close)
			validator, err := NewJWTValidator(server.URL, "node-1", "test-issuer", "node-management")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(validator.Close)
			token := jwt.NewWithClaims(jwt.SigningMethodRS256, Claims{
				RegisteredClaims: jwt.RegisteredClaims{
					Issuer: "test-issuer", Audience: jwt.ClaimStrings{"node-management"},
					ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute)),
				},
				Node: "node-1", Workspace: "workspace-1",
			})
			if tc.withKid {
				token.Header["kid"] = "test-key-1"
			}
			signed, err := token.SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			claims, err := validator.ValidateNodeManagementToken(signed, "workspace-1")
			if tc.wantErr {
				if err == nil {
					t.Fatal("accepted token with a conflicting JWK algorithm")
				}
				return
			}
			if err != nil {
				t.Fatalf("valid token rejected: %v", err)
			}
			if claims.Node != "node-1" || claims.Workspace != "workspace-1" {
				t.Fatalf("unexpected identity: node=%q workspace=%q", claims.Node, claims.Workspace)
			}
		})
	}
}
