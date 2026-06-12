package deploy

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
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

	canonical := buildSignableBytes(payload)

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

// buildSignableBytes constructs the canonical byte representation for signing.
func buildSignableBytes(payload *ApplyPayload) []byte {
	composeHash := sha256.Sum256([]byte(payload.ComposeYAML))
	routes := payload.Routes
	if routes == nil {
		routes = []RouteTarget{}
	}
	routesBytes, _ := json.Marshal(routes)
	routesHash := sha256.Sum256(routesBytes)
	signable := SignablePayload{
		EnvironmentID: payload.EnvironmentID,
		NodeID:        payload.NodeID,
		Seq:           payload.Seq,
		ExpiresAt:     payload.ExpiresAt,
		ComposeHash:   hex.EncodeToString(composeHash[:]),
		RoutesHash:    hex.EncodeToString(routesHash[:]),
	}
	// JSON marshal with sorted keys (Go's encoding/json sorts by struct field order)
	b, _ := json.Marshal(signable)
	return b
}

// SignPayload signs an apply payload with an Ed25519 private key.
// This is used by the control plane (API) to sign payloads before sending to nodes.
func SignPayload(payload *ApplyPayload, privKey ed25519.PrivateKey) (string, error) {
	canonical := buildSignableBytes(payload)
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
