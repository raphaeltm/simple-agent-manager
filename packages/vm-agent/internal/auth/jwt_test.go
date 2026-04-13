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
