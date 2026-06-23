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

func TestVerifier_RejectsInterpolationEnvMutationAfterSigning(t *testing.T) {
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
		InterpolationEnv: map[string]string{
			"DATABASE_URL": "postgres://user:pass@host/db",
		},
	}
	sig, _ := SignPayload(payload, priv)
	payload.Signature = sig
	payload.InterpolationEnv["DATABASE_URL"] = "postgres://attacker/db"

	err = v.Verify(payload, "env-1", "node-1", 0)
	if err == nil {
		t.Error("expected signature verification to fail after interpolation env mutation")
	}
}

func TestVerifier_RejectsArtifactMutationAfterSigning(t *testing.T) {
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
		Artifacts: []ImageArtifact{{
			ServiceName:       "web",
			SourceRef:         "workspace-web",
			LocalImageRef:     "sam-env-1-web:release",
			R2Key:             "compose-image-artifacts/proj/env/ws/upload/web.tar",
			SizeBytes:         12,
			ArchiveSHA256:     "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			ArchiveType:       "docker-save",
			MediaType:         "application/vnd.docker.image.rootfs.diff.tar",
			DownloadURL:       "https://example.test/web.tar",
			DownloadExpiresIn: 900,
		}},
	}
	sig, _ := SignPayload(payload, priv)
	payload.Signature = sig
	payload.Artifacts[0].R2Key = "compose-image-artifacts/proj/env/ws/upload/other.tar"

	err = v.Verify(payload, "env-1", "node-1", 0)
	if err == nil {
		t.Error("expected signature verification to fail after artifact mutation")
	}
}

func TestBuildSignableBytesMatchesJavaScriptJSONContractForEscapedStrings(t *testing.T) {
	payload := &ApplyPayload{
		EnvironmentID: "env-1",
		NodeID:        "node-1",
		Seq:           1,
		ExpiresAt:     1800000000,
		ComposeYAML:   "compose yaml",
		InterpolationEnv: map[string]string{
			"DATABASE_URL": "postgres://user:pass@host/db?sslmode=require&connect_timeout=5",
		},
		Artifacts: []ImageArtifact{{
			ServiceName:       "api",
			SourceRef:         "deploy-test-api",
			LocalImageRef:     "sam-env-api:rel",
			R2Key:             "compose-image-artifacts/proj/env/ws/upload/api.tar",
			SizeBytes:         204690944,
			ArchiveSHA256:     "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			ArchiveType:       "docker-save",
			MediaType:         "application/vnd.docker.image.rootfs.diff.tar",
			DownloadURL:       "https://example.r2.cloudflarestorage.com/bucket/key?X-Amz-Date=20260623T100000Z&X-Amz-Expires=900&X-Amz-Signature=abc",
			DownloadExpiresIn: 900,
		}},
	}

	var signable SignablePayload
	signableBytes, err := buildSignableBytes(payload)
	if err != nil {
		t.Fatalf("build signable bytes: %v", err)
	}
	if err := json.Unmarshal(signableBytes, &signable); err != nil {
		t.Fatalf("decode signable bytes: %v", err)
	}

	// These hashes are generated from the TypeScript control plane's
	// JSON.stringify contract. Go's default json.Marshal escapes &, <, and >,
	// which changes these hashes and makes signed R2 apply payloads unverifiable.
	if signable.ArtifactsHash != "ee2ad42b44ddd98f2733d012aaec70371cf274838dcf0fe0388b261fde9dc026" {
		t.Fatalf("unexpected artifacts hash: %s", signable.ArtifactsHash)
	}
	if signable.InterpolationEnvHash != "80ee540b85bb3f4525ec03e7a28ed8bfbfbf0f26f07a595dccca77f94ed1ba52" {
		t.Fatalf("unexpected interpolation env hash: %s", signable.InterpolationEnvHash)
	}
}

func TestHashInterpolationEnvCanonicalizesSortedEntries(t *testing.T) {
	first, err := hashInterpolationEnv(map[string]string{
		"B": "two",
		"A": "one",
	})
	if err != nil {
		t.Fatalf("hash first env: %v", err)
	}
	second, err := hashInterpolationEnv(map[string]string{
		"A": "one",
		"B": "two",
	})
	if err != nil {
		t.Fatalf("hash second env: %v", err)
	}
	if first != second {
		t.Fatalf("expected insertion order independent hash, got %s and %s", first, second)
	}

	empty, err := hashInterpolationEnv(nil)
	if err != nil {
		t.Fatalf("hash empty env: %v", err)
	}
	if empty != "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945" {
		t.Fatalf("unexpected empty env hash: %s", empty)
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
