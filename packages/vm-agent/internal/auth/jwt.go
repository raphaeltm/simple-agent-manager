// Package auth provides JWT validation using JWKS.
package auth

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

const nodeManagementAudience = "node-management"
const workspaceCallbackAudience = "workspace-callback"
const localForwardAudience = "local-forward"
const nodeIDMismatchFormat = "node ID mismatch: expected %s, got %s"

// Claims represents JWT claims accepted by the node agent.
type Claims struct {
	jwt.RegisteredClaims
	Workspace      string `json:"workspace,omitempty"`
	Node           string `json:"node,omitempty"`
	Type           string `json:"type,omitempty"`
	Scope          string `json:"scope,omitempty"`
	UserID         string `json:"userId,omitempty"`
	RemotePort     int    `json:"remotePort,omitempty"`
	Mode           string `json:"mode,omitempty"`
	LocalAuthority string `json:"localAuthority,omitempty"`
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
	if err := ValidateJWKSURL(jwksURL); err != nil {
		return nil, err
	}

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

// ValidateJWKSURL requires HTTPS for remote JWKS endpoints while preserving
// explicit local-development HTTP endpoints used by tests and local wrangler.
func ValidateJWKSURL(rawURL string) error {
	return validateHTTPSOrLocalHTTPURL(rawURL, "JWKS endpoint")
}

// ValidateIssuerURL requires HTTPS for URL-form issuers while preserving
// local-development HTTP issuers. Non-URL issuer strings are accepted for
// compatibility with existing token issuers such as "test-issuer".
func ValidateIssuerURL(issuer string) error {
	trimmed := strings.TrimSpace(issuer)
	if trimmed == "" {
		return fmt.Errorf("JWT issuer is required")
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Scheme == "" {
		return nil
	}
	return validateHTTPSOrLocalHTTPURL(trimmed, "JWT issuer")
}

func validateHTTPSOrLocalHTTPURL(rawURL, label string) error {
	trimmed := strings.TrimSpace(rawURL)
	if trimmed == "" {
		return fmt.Errorf("%s is required", label)
	}
	u, err := url.Parse(trimmed)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return fmt.Errorf("%s must be an absolute URL", label)
	}
	switch u.Scheme {
	case "https":
		return nil
	case "http":
		if isLocalDevelopmentHost(u.Hostname()) {
			return nil
		}
		return fmt.Errorf("%s must use https for remote hosts; http is allowed only for localhost or loopback development hosts", label)
	default:
		return fmt.Errorf("%s must use http or https scheme, got %q", label, u.Scheme)
	}
}

func isLocalDevelopmentHost(host string) bool {
	normalized := strings.TrimSuffix(strings.ToLower(host), ".")
	if normalized == "localhost" {
		return true
	}
	ip := net.ParseIP(normalized)
	return ip != nil && ip.IsLoopback()
}

func (v *JWTValidator) parse(tokenString string) (*Claims, error) {
	token, err := jwt.ParseWithClaims(tokenString, &Claims{}, v.jwks.Keyfunc,
		jwt.WithValidMethods([]string{"EdDSA", "RS256"}))
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
		return nil, fmt.Errorf(nodeIDMismatchFormat, v.nodeID, claims.Node)
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

func validateWorkspaceClaim(claims *Claims, workspaceID string) error {
	if claims.Workspace == "" {
		return fmt.Errorf("workspace claim is required")
	}

	if workspaceID != "" && claims.Workspace != workspaceID {
		return fmt.Errorf("workspace ID mismatch: expected %s, got %s", workspaceID, claims.Workspace)
	}

	return nil
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

	if err := validateWorkspaceClaim(claims, workspaceID); err != nil {
		return nil, err
	}

	return claims, nil
}

// ValidateWorkspaceCallbackToken validates a workspace-scoped VM callback token.
func (v *JWTValidator) ValidateWorkspaceCallbackToken(tokenString, workspaceID string) (*Claims, error) {
	claims, err := v.parse(tokenString)
	if err != nil {
		return nil, err
	}

	if err := validateAudience(claims, workspaceCallbackAudience); err != nil {
		return nil, err
	}
	if err := validateWorkspaceClaim(claims, workspaceID); err != nil {
		return nil, err
	}
	if claims.ExpiresAt == nil {
		return nil, fmt.Errorf("expiration claim is required")
	}
	if claims.Subject != claims.Workspace {
		return nil, fmt.Errorf("subject must match workspace claim")
	}
	if claims.Type != "callback" {
		return nil, fmt.Errorf("callback token type is required")
	}
	if claims.Scope != "workspace" {
		return nil, fmt.Errorf("workspace callback scope is required")
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
		return nil, fmt.Errorf(nodeIDMismatchFormat, v.nodeID, claims.Node)
	}

	// When a specific workspace is requested, the token MUST carry a matching
	// workspace claim. An empty claims.Workspace must NOT pass — otherwise a
	// node-scoped token (no workspace claim) could access any workspace.
	if workspaceID != "" && claims.Workspace != workspaceID {
		return nil, fmt.Errorf("workspace ID mismatch: expected %s, got %s", workspaceID, claims.Workspace)
	}

	return claims, nil
}

// ValidateLocalForwardToken validates a non-writing local HTTP forwarding token.
func (v *JWTValidator) ValidateLocalForwardToken(tokenString, workspaceID string, remotePort int) (*Claims, error) {
	claims, err := v.parse(tokenString)
	if err != nil {
		return nil, err
	}
	if err := validateAudience(claims, localForwardAudience); err != nil {
		return nil, err
	}
	if err := validateWorkspaceClaim(claims, workspaceID); err != nil {
		return nil, err
	}
	if claims.ExpiresAt == nil {
		return nil, fmt.Errorf("expiration claim is required")
	}
	if claims.Type != "local-forward" {
		return nil, fmt.Errorf("local forward token type is required")
	}
	if claims.Subject == "" || claims.UserID == "" || claims.Subject != claims.UserID {
		return nil, fmt.Errorf("local forward user claim is invalid")
	}
	if claims.Node != v.nodeID {
		return nil, fmt.Errorf(nodeIDMismatchFormat, v.nodeID, claims.Node)
	}
	if claims.RemotePort != remotePort {
		return nil, fmt.Errorf("remote port mismatch: expected %d, got %d", remotePort, claims.RemotePort)
	}
	if claims.Mode != "http" {
		return nil, fmt.Errorf("local forward mode must be http")
	}
	if claims.LocalAuthority == "" {
		return nil, fmt.Errorf("local authority claim is required")
	}
	return claims, nil
}

// GetUserID extracts the user ID from validated claims.
func (v *JWTValidator) GetUserID(claims *Claims) string {
	return claims.Subject
}

// Close cleans up resources used by the validator.
func (v *JWTValidator) Close() {}
