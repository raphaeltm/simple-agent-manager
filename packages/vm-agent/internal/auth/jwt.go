// Package auth provides JWT validation using JWKS.
package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

const nodeManagementAudience = "node-management"

// Claims represents JWT claims accepted by the node agent.
type Claims struct {
	jwt.RegisteredClaims
	Workspace string `json:"workspace,omitempty"`
	Node      string `json:"node,omitempty"`
	Type      string `json:"type,omitempty"`
}

// JWTValidator validates JWTs using a remote JWKS endpoint.
type JWTValidator struct {
	jwks     keyfunc.Keyfunc
	audience string
	issuer   string
	nodeID   string
}

// NewJWTValidator creates a new JWT validator that fetches keys from the JWKS endpoint.
func NewJWTValidator(jwksURL, nodeID, issuer, audience string) (*JWTValidator, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	k, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("failed to create JWKS keyfunc: %w", err)
	}

	return &JWTValidator{
		jwks:     k,
		audience: audience,
		issuer:   issuer,
		nodeID:   nodeID,
	}, nil
}

func (v *JWTValidator) parse(tokenString string) (*Claims, error) {
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

	iss, err := claims.GetIssuer()
	if err != nil {
		return nil, fmt.Errorf("failed to get issuer: %w", err)
	}
	if iss != v.issuer {
		return nil, fmt.Errorf("invalid issuer: expected %s, got %s", v.issuer, iss)
	}

	if claims.Node != "" && claims.Node != v.nodeID {
		return nil, fmt.Errorf("node ID mismatch: expected %s, got %s", v.nodeID, claims.Node)
	}

	return claims, nil
}

func validateAudience(claims *Claims, expectedAudience string) error {
	aud, err := claims.GetAudience()
	if err != nil {
		return fmt.Errorf("failed to get audience: %w", err)
	}

	for _, audience := range aud {
		if audience == expectedAudience {
			return nil
		}
	}

	return fmt.Errorf("invalid audience: expected %s", expectedAudience)
}

// Validate validates a token using the default audience.
func (v *JWTValidator) Validate(tokenString string) (*Claims, error) {
	claims, err := v.parse(tokenString)
	if err != nil {
		return nil, err
	}

	if err := validateAudience(claims, v.audience); err != nil {
		return nil, err
	}

	return claims, nil
}

// ValidateWorkspaceToken validates a user terminal token and enforces workspace claim.
func (v *JWTValidator) ValidateWorkspaceToken(tokenString, workspaceID string) (*Claims, error) {
	claims, err := v.Validate(tokenString)
	if err != nil {
		return nil, err
	}

	if claims.Workspace == "" {
		return nil, fmt.Errorf("workspace claim is required")
	}

	if workspaceID != "" && claims.Workspace != workspaceID {
		return nil, fmt.Errorf("workspace ID mismatch: expected %s, got %s", workspaceID, claims.Workspace)
	}

	return claims, nil
}

// ValidateNodeManagementToken validates a control-plane management token.
func (v *JWTValidator) ValidateNodeManagementToken(tokenString, workspaceID string) (*Claims, error) {
	claims, err := v.parse(tokenString)
	if err != nil {
		return nil, err
	}

	if err := validateAudience(claims, nodeManagementAudience); err != nil {
		return nil, err
	}

	if claims.Node != v.nodeID {
		return nil, fmt.Errorf("node ID mismatch: expected %s, got %s", v.nodeID, claims.Node)
	}

	if workspaceID != "" && claims.Workspace != "" && claims.Workspace != workspaceID {
		return nil, fmt.Errorf("workspace ID mismatch: expected %s, got %s", workspaceID, claims.Workspace)
	}

	return claims, nil
}

// GetUserID extracts the user ID from validated claims.
func (v *JWTValidator) GetUserID(claims *Claims) string {
	return claims.Subject
}

// Close cleans up resources used by the validator.
func (v *JWTValidator) Close() {}
