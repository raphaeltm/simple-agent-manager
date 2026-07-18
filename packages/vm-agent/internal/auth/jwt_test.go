package auth

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestValidateJWKSURLRequiresHTTPSForRemoteHosts(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{name: "remote https", url: "https://api.example.com/.well-known/jwks.json"},
		{name: "localhost http", url: "http://localhost:8787/.well-known/jwks.json"},
		{name: "loopback ipv4 http", url: "http://127.0.0.1:8787/.well-known/jwks.json"},
		{name: "loopback ipv6 http", url: "http://[::1]:8787/.well-known/jwks.json"},
		{name: "remote http rejected", url: "http://api.example.com/.well-known/jwks.json", wantErr: true},
		{name: "private lan http rejected", url: "http://192.168.1.20/.well-known/jwks.json", wantErr: true},
		{name: "invalid scheme rejected", url: "ftp://api.example.com/.well-known/jwks.json", wantErr: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := ValidateJWKSURL(tc.url)
			if tc.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestValidateIssuerURLAllowsNonURLIssuersAndLocalHTTP(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name    string
		issuer  string
		wantErr bool
	}{
		{name: "plain issuer", issuer: "test-issuer"},
		{name: "remote https", issuer: "https://api.example.com"},
		{name: "localhost http", issuer: "http://localhost:8787"},
		{name: "loopback http", issuer: "http://127.0.0.1:8787"},
		{name: "remote http rejected", issuer: "http://api.example.com", wantErr: true},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			err := ValidateIssuerURL(tc.issuer)
			if tc.wantErr && err == nil {
				t.Fatal("expected error")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestNewJWTValidatorRejectsRemoteHTTPJWKSBeforeFetch(t *testing.T) {
	t.Parallel()

	validator, err := NewJWTValidator("http://api.example.com/.well-known/jwks.json", "node-1", "https://api.example.com", "workspace-terminal")
	if err == nil {
		if validator != nil {
			validator.Close()
		}
		t.Fatal("expected remote http JWKS error")
	}
	if !strings.Contains(err.Error(), "JWKS endpoint must use https") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// testJWKS sets up a local JWKS server and returns a JWTValidator for testing.
func testJWKS(t *testing.T, nodeID string) (*JWTValidator, *rsa.PrivateKey) {
	t.Helper()

	privateKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate RSA key: %v", err)
	}

	// Build JWKS JSON manually from public key
	pubKey := privateKey.Public().(*rsa.PublicKey)
	jwksJSON := buildJWKSJSON(pubKey)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(jwksJSON)
	}))
	t.Cleanup(server.Close)

	validator, err := NewJWTValidator(server.URL, nodeID, "test-issuer", "test-audience")
	if err != nil {
		t.Fatalf("create validator: %v", err)
	}
	t.Cleanup(validator.Close)

	return validator, privateKey
}

func buildJWKSJSON(pub *rsa.PublicKey) []byte {
	n := base64.RawURLEncoding.EncodeToString(pub.N.Bytes())
	e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(pub.E)).Bytes())
	jwks := map[string]interface{}{
		"keys": []map[string]interface{}{
			{
				"kty": "RSA",
				"alg": "RS256",
				"use": "sig",
				"kid": "test-key-1",
				"n":   n,
				"e":   e,
			},
		},
	}
	data, _ := json.Marshal(jwks)
	return data
}

func signToken(t *testing.T, key *rsa.PrivateKey, claims Claims) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodRS256, claims)
	token.Header["kid"] = "test-key-1"
	signed, err := token.SignedString(key)
	if err != nil {
		t.Fatalf("sign token: %v", err)
	}
	return signed
}

func signWorkspaceCallbackToken(t *testing.T, key *rsa.PrivateKey, mutate func(*Claims)) string {
	t.Helper()
	claims := Claims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "test-issuer",
			Subject:   "ws-123",
			Audience:  jwt.ClaimStrings{"workspace-callback"},
			ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Hour)),
		},
		Workspace: "ws-123",
		Type:      "callback",
		Scope:     "workspace",
	}
	if mutate != nil {
		mutate(&claims)
	}
	return signToken(t, key, claims)
}

func TestValidateNodeManagementToken_WorkspaceBypass(t *testing.T) {
	t.Parallel()

	const nodeID = "node-123"
	validator, key := testJWKS(t, nodeID)

	t.Run("empty workspace claim rejected when workspaceID requested", func(t *testing.T) {
		t.Parallel()
		// Token with no workspace claim — should NOT be able to access ws-456
		tokenStr := signToken(t, key, Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "test-issuer",
				Audience:  jwt.ClaimStrings{"node-management"},
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			},
			Node:      nodeID,
			Workspace: "", // empty — node-scoped token
		})

		_, err := validator.ValidateNodeManagementToken(tokenStr, "ws-456")
		if err == nil {
			t.Fatal("expected error when empty workspace claim used to access a specific workspace")
		}
		if !strings.Contains(err.Error(), "workspace ID mismatch") {
			t.Errorf("expected workspace mismatch error, got: %s", err)
		}
	})

	t.Run("matching workspace claim accepted", func(t *testing.T) {
		t.Parallel()
		tokenStr := signToken(t, key, Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "test-issuer",
				Audience:  jwt.ClaimStrings{"node-management"},
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			},
			Node:      nodeID,
			Workspace: "ws-456",
		})

		claims, err := validator.ValidateNodeManagementToken(tokenStr, "ws-456")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if claims.Workspace != "ws-456" {
			t.Errorf("expected workspace ws-456, got %s", claims.Workspace)
		}
	})

	t.Run("mismatched workspace claim rejected", func(t *testing.T) {
		t.Parallel()
		tokenStr := signToken(t, key, Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "test-issuer",
				Audience:  jwt.ClaimStrings{"node-management"},
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			},
			Node:      nodeID,
			Workspace: "ws-789",
		})

		_, err := validator.ValidateNodeManagementToken(tokenStr, "ws-456")
		if err == nil {
			t.Fatal("expected error for mismatched workspace claim")
		}
	})

	t.Run("empty workspaceID skips workspace check", func(t *testing.T) {
		t.Parallel()
		// When no specific workspace is requested, any workspace claim is fine
		tokenStr := signToken(t, key, Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "test-issuer",
				Audience:  jwt.ClaimStrings{"node-management"},
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			},
			Node:      nodeID,
			Workspace: "",
		})

		_, err := validator.ValidateNodeManagementToken(tokenStr, "")
		if err != nil {
			t.Fatalf("unexpected error for empty workspaceID: %v", err)
		}
	})

	t.Run("empty node claim rejected by management token validation", func(t *testing.T) {
		t.Parallel()
		// A token without a node claim must not pass management token validation,
		// even if the workspace claim matches. This prevents lateral movement
		// between nodes in multi-node deployments.
		tokenStr := signToken(t, key, Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "test-issuer",
				Audience:  jwt.ClaimStrings{"node-management"},
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			},
			Node:      "", // no node claim
			Workspace: "ws-456",
		})

		_, err := validator.ValidateNodeManagementToken(tokenStr, "ws-456")
		if err == nil {
			t.Fatal("expected error: management token with empty Node should be rejected")
		}
		if !strings.Contains(err.Error(), "node ID mismatch") {
			t.Errorf("expected node mismatch error, got: %s", err)
		}
	})
}

func TestJWTValidation_CoreProperties(t *testing.T) {
	t.Parallel()

	const nodeID = "node-123"
	validator, key := testJWKS(t, nodeID)

	t.Run("expired token rejected", func(t *testing.T) {
		t.Parallel()
		tokenStr := signToken(t, key, Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "test-issuer",
				Audience:  jwt.ClaimStrings{"node-management"},
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(-1 * time.Second)),
			},
			Node: nodeID,
		})

		_, err := validator.ValidateNodeManagementToken(tokenStr, "")
		if err == nil {
			t.Fatal("expected error for expired token")
		}
	})

	t.Run("wrong issuer rejected", func(t *testing.T) {
		t.Parallel()
		tokenStr := signToken(t, key, Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "wrong-issuer",
				Audience:  jwt.ClaimStrings{"node-management"},
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			},
			Node: nodeID,
		})

		_, err := validator.ValidateNodeManagementToken(tokenStr, "")
		if err == nil {
			t.Fatal("expected error for wrong issuer")
		}
		if !strings.Contains(err.Error(), "issuer") {
			t.Errorf("expected issuer error, got: %s", err)
		}
	})

	t.Run("wrong audience rejected", func(t *testing.T) {
		t.Parallel()
		tokenStr := signToken(t, key, Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "test-issuer",
				Audience:  jwt.ClaimStrings{"wrong-audience"},
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			},
			Node: nodeID,
		})

		_, err := validator.ValidateNodeManagementToken(tokenStr, "")
		if err == nil {
			t.Fatal("expected error for wrong audience")
		}
		if !strings.Contains(err.Error(), "audience") {
			t.Errorf("expected audience error, got: %s", err)
		}
	})

	t.Run("token signed with different key rejected", func(t *testing.T) {
		t.Parallel()
		// Generate a different RSA key not in the JWKS
		otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatalf("generate other key: %v", err)
		}
		tokenStr := signToken(t, otherKey, Claims{
			RegisteredClaims: jwt.RegisteredClaims{
				Issuer:    "test-issuer",
				Audience:  jwt.ClaimStrings{"node-management"},
				ExpiresAt: jwt.NewNumericDate(time.Now().Add(1 * time.Hour)),
			},
			Node: nodeID,
		})

		_, err = validator.ValidateNodeManagementToken(tokenStr, "")
		if err == nil {
			t.Fatal("expected error for token signed with unknown key")
		}
	})
}

func TestValidateWorkspaceCallbackToken(t *testing.T) {
	t.Parallel()

	const nodeID = "node-123"
	validator, key := testJWKS(t, nodeID)

	t.Run("matching workspace callback token accepted", func(t *testing.T) {
		t.Parallel()
		tokenStr := signWorkspaceCallbackToken(t, key, nil)

		claims, err := validator.ValidateWorkspaceCallbackToken(tokenStr, "ws-123")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if claims.Workspace != "ws-123" {
			t.Fatalf("expected workspace ws-123, got %q", claims.Workspace)
		}
	})

	t.Run("wrong audience rejected", func(t *testing.T) {
		t.Parallel()
		tokenStr := signWorkspaceCallbackToken(t, key, func(claims *Claims) {
			claims.Audience = jwt.ClaimStrings{"workspace-terminal"}
		})

		if _, err := validator.ValidateWorkspaceCallbackToken(tokenStr, "ws-123"); err == nil {
			t.Fatal("expected wrong audience to be rejected")
		}
	})

	t.Run("wrong workspace rejected", func(t *testing.T) {
		t.Parallel()
		tokenStr := signWorkspaceCallbackToken(t, key, func(claims *Claims) {
			claims.Subject = "ws-other"
			claims.Workspace = "ws-other"
		})

		if _, err := validator.ValidateWorkspaceCallbackToken(tokenStr, "ws-123"); err == nil {
			t.Fatal("expected wrong workspace to be rejected")
		}
	})

	t.Run("node scoped callback rejected", func(t *testing.T) {
		t.Parallel()
		tokenStr := signWorkspaceCallbackToken(t, key, func(claims *Claims) {
			claims.Scope = "node"
		})

		if _, err := validator.ValidateWorkspaceCallbackToken(tokenStr, "ws-123"); err == nil {
			t.Fatal("expected node-scoped callback token to be rejected")
		}
	})

	t.Run("missing expiration rejected", func(t *testing.T) {
		t.Parallel()
		tokenStr := signWorkspaceCallbackToken(t, key, func(claims *Claims) {
			claims.ExpiresAt = nil
		})

		if _, err := validator.ValidateWorkspaceCallbackToken(tokenStr, "ws-123"); err == nil {
			t.Fatal("expected missing expiration to be rejected")
		}
	})

	t.Run("subject mismatch rejected", func(t *testing.T) {
		t.Parallel()
		tokenStr := signWorkspaceCallbackToken(t, key, func(claims *Claims) {
			claims.Subject = "not-the-workspace"
		})

		if _, err := validator.ValidateWorkspaceCallbackToken(tokenStr, "ws-123"); err == nil {
			t.Fatal("expected subject mismatch to be rejected")
		}
	})
}
