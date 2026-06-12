package deploy

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"testing"
	"time"
)

func generateTestKeys(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return pub, priv
}

func makeTestPayload(envID, nodeID string, seq int64, composeYAML string, privKey ed25519.PrivateKey) *ApplyPayload {
	payload := &ApplyPayload{
		EnvironmentID: envID,
		NodeID:        nodeID,
		Seq:           seq,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   composeYAML,
	}
	sig, _ := SignPayload(payload, privKey)
	payload.Signature = sig
	return payload
}

func TestVerifier_ValidSignature(t *testing.T) {
	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	v, err := NewVerifier(pubB64)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	payload := makeTestPayload("env-1", "node-1", 1, "version: '3'\nservices:\n  web:\n    image: nginx", priv)

	err = v.Verify(payload, "env-1", "node-1", 0)
	if err != nil {
		t.Errorf("expected valid signature, got: %v", err)
	}
}

func TestVerifier_WrongKey(t *testing.T) {
	pub, _ := generateTestKeys(t)
	_, wrongPriv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	v, err := NewVerifier(pubB64)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	payload := makeTestPayload("env-1", "node-1", 1, "compose yaml", wrongPriv)

	err = v.Verify(payload, "env-1", "node-1", 0)
	if err == nil {
		t.Error("expected signature verification to fail with wrong key")
	}
}

func TestVerifier_RejectsRouteMutationAfterSigning(t *testing.T) {
	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	v, err := NewVerifier(pubB64)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(1 * time.Hour).Unix(),
		ComposeYAML:   "compose yaml",
		Routes: []RouteTarget{{
			Hostname:      "app.apps.example.com",
			Service:       "web",
			ContainerPort: 3000,
			HostPort:      35000,
		}},
	}
	sig, _ := SignPayload(payload, priv)
	payload.Signature = sig
	payload.Routes[0].HostPort = 35001

	err = v.Verify(payload, "env-1", "node-1", 0)
	if err == nil {
		t.Error("expected signature verification to fail after route mutation")
	}
}

func TestVerifier_WrongEnvironment(t *testing.T) {
	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	v, err := NewVerifier(pubB64)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	payload := makeTestPayload("env-1", "node-1", 1, "compose yaml", priv)

	err = v.Verify(payload, "env-WRONG", "node-1", 0)
	if err == nil {
		t.Error("expected environment mismatch rejection")
	}
}

func TestVerifier_WrongNode(t *testing.T) {
	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	v, err := NewVerifier(pubB64)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	payload := makeTestPayload("env-1", "node-1", 1, "compose yaml", priv)

	err = v.Verify(payload, "env-1", "node-WRONG", 0)
	if err == nil {
		t.Error("expected node mismatch rejection")
	}
}

func TestVerifier_SequenceReplay(t *testing.T) {
	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	v, err := NewVerifier(pubB64)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	// Sequence 5, but last applied is already 5
	payload := makeTestPayload("env-1", "node-1", 5, "compose yaml", priv)

	err = v.Verify(payload, "env-1", "node-1", 5)
	if err == nil {
		t.Error("expected sequence replay rejection (equal)")
	}

	// Sequence 3, last applied is 5
	payload = makeTestPayload("env-1", "node-1", 3, "compose yaml", priv)

	err = v.Verify(payload, "env-1", "node-1", 5)
	if err == nil {
		t.Error("expected sequence replay rejection (less than)")
	}
}

func TestVerifier_Expired(t *testing.T) {
	pub, priv := generateTestKeys(t)
	pubB64 := base64.StdEncoding.EncodeToString(pub)

	v, err := NewVerifier(pubB64)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     time.Now().Add(-1 * time.Hour).Unix(), // expired
		ComposeYAML:   "compose yaml",
	}
	sig, _ := SignPayload(payload, priv)
	payload.Signature = sig

	err = v.Verify(payload, "env-1", "node-1", 0)
	if err == nil {
		t.Error("expected expired payload rejection")
	}
}

func TestVerifier_DualKeyRotation(t *testing.T) {
	oldPub, oldPriv := generateTestKeys(t)
	newPub, _ := generateTestKeys(t)

	oldPubB64 := base64.StdEncoding.EncodeToString(oldPub)
	newPubB64 := base64.StdEncoding.EncodeToString(newPub)

	v, err := NewVerifier(oldPubB64)
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}

	// Rotate to new key — old key becomes previous
	if err := v.SetCurrentKey(newPubB64); err != nil {
		t.Fatalf("SetCurrentKey: %v", err)
	}

	// Payload signed with old key should still verify (rotation window)
	payload := makeTestPayload("env-1", "node-1", 1, "compose yaml", oldPriv)

	err = v.Verify(payload, "env-1", "node-1", 0)
	if err != nil {
		t.Errorf("expected old-key payload to verify during rotation window, got: %v", err)
	}
}

func TestVerifier_InvalidKeySize(t *testing.T) {
	_, err := NewVerifier(base64.StdEncoding.EncodeToString([]byte("too short")))
	if err == nil {
		t.Error("expected error for invalid key size")
	}
}

func TestVerifier_InvalidBase64(t *testing.T) {
	_, err := NewVerifier("not-valid-base64!!!")
	if err == nil {
		t.Error("expected error for invalid base64")
	}
}

func TestVerifier_AcceptsSharedApiRoutePayloadFixture(t *testing.T) {
	bytes, err := os.ReadFile("../../../../tests/fixtures/deploy-release/apply-payload-with-routes.json")
	if err != nil {
		t.Fatalf("read contract fixture: %v", err)
	}

	var payload ApplyPayload
	if err := json.Unmarshal(bytes, &payload); err != nil {
		t.Fatalf("decode contract fixture: %v", err)
	}

	if len(payload.Routes) != 2 {
		t.Fatalf("expected 2 route targets, got %d", len(payload.Routes))
	}
	if payload.Routes[0].Hostname != "r1-web-3000-env-1.apps.sammy.party" {
		t.Fatalf("unexpected first route: %#v", payload.Routes[0])
	}
	if payload.Routes[0].HostPort != 35000 || payload.Routes[1].HostPort != 35001 {
		t.Fatalf("unexpected host ports: %#v", payload.Routes)
	}

	verifier, err := NewVerifier("ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ=")
	if err != nil {
		t.Fatalf("NewVerifier: %v", err)
	}
	if err := verifier.Verify(&payload, "env-1", "node-1", 0); err != nil {
		t.Fatalf("Verify shared API fixture: %v", err)
	}
}
