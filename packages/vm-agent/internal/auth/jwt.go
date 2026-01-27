// Package auth provides JWT validation using JWKS.
package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// Claims represents the JWT claims for terminal access.
type Claims struct {
	jwt.RegisteredClaims
	Workspace string `json:"workspace"`
}

// JWTValidator validates JWTs using a remote JWKS endpoint.
type JWTValidator struct {
	jwks         *keyfunc.Keyfunc
	audience     string
	issuer       string
	workspaceID  string
}

// NewJWTValidator creates a new JWT validator that fetches keys from the JWKS endpoint.
func NewJWTValidator(jwksURL, workspaceID string) (*JWTValidator, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Create a keyfunc that will fetch and cache JWKS
	k, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("failed to create JWKS keyfunc: %w", err)
	}

	return &JWTValidator{
		jwks:        k,
		audience:    "vm-agent",
		issuer:      "cloud-ai-workspaces",
		workspaceID: workspaceID,
	}, nil
}

// Validate validates a JWT token and returns the claims if valid.
func (v *JWTValidator) Validate(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, v.jwks.Keyfunc)
	if err != nil {
		return nil, fmt.Errorf("failed to parse token: %w", err)
	}

	if !token.Valid {
		return nil, fmt.Errorf("invalid token")
	}

	claims, ok := token.Claims.(*Claims)
	if !ok {
		return nil, fmt.Errorf("invalid claims type")
	}

	// Validate audience
	aud, err := claims.GetAudience()
	if err != nil {
		return nil, fmt.Errorf("failed to get audience: %w", err)
	}
	audienceValid := false
	for _, a := range aud {
		if a == v.audience || a == "workspace-terminal" {
			audienceValid = true
			break
		}
	}
	if !audienceValid {
		return nil, fmt.Errorf("invalid audience")
	}

	// Validate workspace ID
	if claims.Workspace != v.workspaceID {
		return nil, fmt.Errorf("workspace ID mismatch: expected %s, got %s", v.workspaceID, claims.Workspace)
	}

	return claims, nil
}

// GetUserID extracts the user ID from validated claims.
func (v *JWTValidator) GetUserID(claims *Claims) string {
	return claims.Subject
}

// Close cleans up resources used by the validator.
func (v *JWTValidator) Close() {
	// The keyfunc will stop refreshing in the background
}
