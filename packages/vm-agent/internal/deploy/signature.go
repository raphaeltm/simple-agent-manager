package deploy

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
	"time"
)

// Verifier validates signed apply payloads using Ed25519 public keys.
// It supports dual-key rotation: both the current and previous public key
// are accepted during a rotation window. All methods are goroutine-safe.
type Verifier struct {
	mu          sync.RWMutex
	currentKey  ed25519.PublicKey
	previousKey ed25519.PublicKey // nil when no rotation in progress
}

// NewVerifier creates a Verifier from a base64-encoded Ed25519 public key.
func NewVerifier(pubKeyB64 string) (*Verifier, error) {
	key, err := decodePublicKey(pubKeyB64)
	if err != nil {
		return nil, fmt.Errorf("decode signing public key: %w", err)
	}
	return &Verifier{currentKey: key}, nil
}

// SetCurrentKey updates the current signing key and moves the old current key
// to the previous slot for dual-key rotation. Goroutine-safe.
func (v *Verifier) SetCurrentKey(pubKeyB64 string) error {
	key, err := decodePublicKey(pubKeyB64)
	if err != nil {
		return fmt.Errorf("decode new signing public key: %w", err)
	}
	v.mu.Lock()
	v.previousKey = v.currentKey
	v.currentKey = key
	v.mu.Unlock()
	return nil
}

// Verify checks the apply payload's signature and all binding constraints.
// Returns nil if valid, or an error describing the rejection reason. Goroutine-safe.
func (v *Verifier) Verify(payload *ApplyPayload, expectedEnvID, expectedNodeID string, lastAppliedSeq int64) error {
	// Check expiry
	if time.Now().Unix() > payload.ExpiresAt {
		return fmt.Errorf("payload expired at %d, current time %d", payload.ExpiresAt, time.Now().Unix())
	}

	// Check environment binding
	if payload.EnvironmentID != expectedEnvID {
		return fmt.Errorf("environment mismatch: payload=%q expected=%q", payload.EnvironmentID, expectedEnvID)
	}

	// Check node binding
	if payload.NodeID != expectedNodeID {
		return fmt.Errorf("node mismatch: payload=%q expected=%q", payload.NodeID, expectedNodeID)
	}

	// Check monotonic sequence (must be strictly greater)
	if payload.Seq <= lastAppliedSeq {
		return fmt.Errorf("sequence replay: payload seq=%d <= last applied seq=%d", payload.Seq, lastAppliedSeq)
	}

	// Verify signature
	sigBytes, err := base64.StdEncoding.DecodeString(payload.Signature)
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}

	canonical, err := buildSignableBytes(payload)
	if err != nil {
		return fmt.Errorf("build signable payload: %w", err)
	}

	// Take read lock to safely access current/previous keys during rotation
	v.mu.RLock()
	currentKey := v.currentKey
	previousKey := v.previousKey
	v.mu.RUnlock()

	// Try current key first, then previous key (dual-key rotation window)
	if ed25519.Verify(currentKey, canonical, sigBytes) {
		return nil
	}
	if previousKey != nil && ed25519.Verify(previousKey, canonical, sigBytes) {
		return nil
	}

	return fmt.Errorf("signature verification failed")
}


// VerifyRouteConfig checks a signed route-only Caddy configuration payload.
func (v *Verifier) VerifyRouteConfig(payload *RouteConfigPayload, expectedEnvID, expectedNodeID string, currentSeq, currentRoutingRevision int64) error {
	if time.Now().Unix() > payload.ExpiresAt {
		return fmt.Errorf("route config expired at %d, current time %d", payload.ExpiresAt, time.Now().Unix())
	}
	if payload.EnvironmentID != expectedEnvID {
		return fmt.Errorf("environment mismatch: payload=%q expected=%q", payload.EnvironmentID, expectedEnvID)
	}
	if payload.NodeID != expectedNodeID {
		return fmt.Errorf("node mismatch: payload=%q expected=%q", payload.NodeID, expectedNodeID)
	}
	if payload.CurrentSeq != currentSeq {
		return fmt.Errorf("current sequence mismatch: payload=%d current=%d", payload.CurrentSeq, currentSeq)
	}
	if payload.RoutingRevision <= currentRoutingRevision {
		return fmt.Errorf("routing revision replay: payload revision=%d <= current routing revision=%d", payload.RoutingRevision, currentRoutingRevision)
	}

	sigBytes, err := base64.StdEncoding.DecodeString(payload.Signature)
	if err != nil {
		return fmt.Errorf("decode signature: %w", err)
	}
	canonical, err := buildRouteConfigSignableBytes(payload)
	if err != nil {
		return fmt.Errorf("build route config signable payload: %w", err)
	}

	v.mu.RLock()
	currentKey := v.currentKey
	previousKey := v.previousKey
	v.mu.RUnlock()
	if ed25519.Verify(currentKey, canonical, sigBytes) {
		return nil
	}
	if previousKey != nil && ed25519.Verify(previousKey, canonical, sigBytes) {
		return nil
	}
	return fmt.Errorf("signature verification failed")
}

// buildSignableBytes constructs the canonical byte representation for signing.
//
// RegistryCredentials are deliberately NOT covered by the signature: they are
// short-lived, server-minted pull-only tokens delivered over TLS from the
// control plane, and the registry/image they authenticate to is already pinned
// by the signed ComposeHash. Tampering with the credentials in transit can only
// cause the pull to fail, not change which image is deployed.
// Image artifacts ARE covered by the signature because they are out-of-band
// object references that decide which local image gets loaded before Compose.
func buildSignableBytes(payload *ApplyPayload) ([]byte, error) {
	composeHash := sha256.Sum256([]byte(payload.ComposeYAML))
	routes := payload.Routes
	if routes == nil {
		routes = []RouteTarget{}
	}
	routesBytes, err := marshalCanonicalJSON(routes)
	if err != nil {
		return nil, fmt.Errorf("marshal routes: %w", err)
	}
	routesHash := sha256.Sum256(routesBytes)
	artifacts := payload.Artifacts
	if artifacts == nil {
		artifacts = []ImageArtifact{}
	}
	artifactsBytes, err := marshalCanonicalJSON(artifacts)
	if err != nil {
		return nil, fmt.Errorf("marshal artifacts: %w", err)
	}
	artifactsHash := sha256.Sum256(artifactsBytes)
	volumeMounts := payload.VolumeMounts
	if volumeMounts == nil {
		volumeMounts = []VolumeMount{}
	}
	volumeMountsBytes, err := marshalCanonicalJSON(volumeMounts)
	if err != nil {
		return nil, fmt.Errorf("marshal volume mounts: %w", err)
	}
	volumeMountsHash := sha256.Sum256(volumeMountsBytes)
	interpolationEnvHash, err := hashInterpolationEnv(payload.InterpolationEnv)
	if err != nil {
		return nil, fmt.Errorf("hash interpolation env: %w", err)
	}
	signable := SignablePayload{
		EnvironmentID:        payload.EnvironmentID,
		NodeID:               payload.NodeID,
		Seq:                  payload.Seq,
		ExpiresAt:            payload.ExpiresAt,
		ComposeHash:          hex.EncodeToString(composeHash[:]),
		RoutesHash:           hex.EncodeToString(routesHash[:]),
		InterpolationEnvHash: interpolationEnvHash,
		ArtifactsHash:        hex.EncodeToString(artifactsHash[:]),
		VolumeMountsHash:     hex.EncodeToString(volumeMountsHash[:]),
	}
	signableBytes, err := marshalCanonicalJSON(signable)
	if err != nil {
		return nil, fmt.Errorf("marshal signable payload: %w", err)
	}
	return signableBytes, nil
}

func buildRouteConfigSignableBytes(payload *RouteConfigPayload) ([]byte, error) {
	routes := payload.Routes
	if routes == nil {
		routes = []RouteTarget{}
	}
	routesBytes, err := marshalCanonicalJSON(routes)
	if err != nil {
		return nil, fmt.Errorf("marshal routes: %w", err)
	}
	routesHash := sha256.Sum256(routesBytes)
	signable := SignableRouteConfigPayload{
		EnvironmentID:   payload.EnvironmentID,
		NodeID:          payload.NodeID,
		CurrentSeq:      payload.CurrentSeq,
		RoutingRevision: payload.RoutingRevision,
		ExpiresAt:       payload.ExpiresAt,
		RoutesHash:      hex.EncodeToString(routesHash[:]),
	}
	signableBytes, err := marshalCanonicalJSON(signable)
	if err != nil {
		return nil, fmt.Errorf("marshal route config signable payload: %w", err)
	}
	return signableBytes, nil
}

func hashInterpolationEnv(env map[string]string) (string, error) {
	type entry [2]string
	entries := make([]entry, 0, len(env))
	for key, value := range env {
		entries = append(entries, entry{key, value})
	}
	sort.Slice(entries, func(i, j int) bool {
		return entries[i][0] < entries[j][0]
	})
	payload, err := marshalCanonicalJSON(entries)
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(payload)
	return hex.EncodeToString(hash[:]), nil
}

func marshalCanonicalJSON(value any) ([]byte, error) {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// SignPayload signs an apply payload with an Ed25519 private key.
// This is used by the control plane (API) to sign payloads before sending to nodes.
func SignPayload(payload *ApplyPayload, privKey ed25519.PrivateKey) (string, error) {
	canonical, err := buildSignableBytes(payload)
	if err != nil {
		return "", err
	}
	sig := ed25519.Sign(privKey, canonical)
	return base64.StdEncoding.EncodeToString(sig), nil
}

func SignRouteConfigPayload(payload *RouteConfigPayload, privKey ed25519.PrivateKey) (string, error) {
	canonical, err := buildRouteConfigSignableBytes(payload)
	if err != nil {
		return "", err
	}
	sig := ed25519.Sign(privKey, canonical)
	return base64.StdEncoding.EncodeToString(sig), nil
}

func decodePublicKey(b64 string) (ed25519.PublicKey, error) {
	keyBytes, err := base64.StdEncoding.DecodeString(b64)
	if err != nil {
		return nil, fmt.Errorf("base64 decode: %w", err)
	}
	if len(keyBytes) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("invalid key size: got %d, want %d", len(keyBytes), ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(keyBytes), nil
}
