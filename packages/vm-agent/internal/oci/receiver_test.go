package oci

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// pushClient drives an httptest.Server through the OCI push-protocol subset the
// receiver implements, mirroring what `docker compose publish` does.
type pushClient struct {
	t    *testing.T
	base string
	repo string
}

func (c *pushClient) do(method, path string, body io.Reader) *http.Response {
	c.t.Helper()
	req, err := http.NewRequest(method, c.base+path, body)
	if err != nil {
		c.t.Fatalf("new request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		c.t.Fatalf("%s %s: %v", method, path, err)
	}
	return resp
}

// pushBlob uploads bytes monolithically and returns the digest the receiver
// assigned, asserting it round-trips.
func (c *pushClient) pushBlob(content []byte) string {
	c.t.Helper()
	want := digest(content)
	resp := c.do(http.MethodPost,
		"/v2/"+c.repo+"/blobs/uploads/?digest="+want, strings.NewReader(string(content)))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		c.t.Fatalf("monolithic blob push: got %d, want 201", resp.StatusCode)
	}
	if got := resp.Header.Get("Docker-Content-Digest"); got != want {
		c.t.Fatalf("blob digest: got %q, want %q", got, want)
	}
	return want
}

// pushBlobChunked uploads bytes via POST(start)/PATCH/PUT and returns the digest.
func (c *pushClient) pushBlobChunked(content []byte) string {
	c.t.Helper()
	want := digest(content)

	start := c.do(http.MethodPost, "/v2/"+c.repo+"/blobs/uploads/", nil)
	start.Body.Close()
	if start.StatusCode != http.StatusAccepted {
		c.t.Fatalf("chunk start: got %d, want 202", start.StatusCode)
	}
	loc := start.Header.Get("Location")
	if loc == "" {
		c.t.Fatal("chunk start: empty Location")
	}

	patch := c.do(http.MethodPatch, loc, strings.NewReader(string(content)))
	patch.Body.Close()
	if patch.StatusCode != http.StatusAccepted {
		c.t.Fatalf("chunk patch: got %d, want 202", patch.StatusCode)
	}

	put := c.do(http.MethodPut, loc+"?digest="+want, nil)
	put.Body.Close()
	if put.StatusCode != http.StatusCreated {
		c.t.Fatalf("chunk put: got %d, want 201", put.StatusCode)
	}
	if got := put.Header.Get("Docker-Content-Digest"); got != want {
		c.t.Fatalf("chunked digest: got %q, want %q", got, want)
	}
	return want
}

// pushManifest marshals m, pushes it under reference, and returns its digest.
func (c *pushClient) pushManifest(reference string, m Manifest) string {
	c.t.Helper()
	raw, err := json.Marshal(m)
	if err != nil {
		c.t.Fatalf("marshal manifest: %v", err)
	}
	want := digest(raw)
	resp := c.do(http.MethodPut, "/v2/"+c.repo+"/manifests/"+reference, strings.NewReader(string(raw)))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		c.t.Fatalf("manifest push %s: got %d, want 201", reference, resp.StatusCode)
	}
	if got := resp.Header.Get("Docker-Content-Digest"); got != want {
		c.t.Fatalf("manifest digest: got %q, want %q", got, want)
	}
	return want
}

func newTestReceiver(t *testing.T, onPublish PublishHandler) (*Receiver, *httptest.Server, *pushClient) {
	t.Helper()
	r := New(Options{OnPublish: onPublish})
	srv := httptest.NewServer(http.HandlerFunc(r.handle))
	t.Cleanup(srv.Close)
	return r, srv, &pushClient{t: t, base: srv.URL, repo: "sam/test-one"}
}

func TestVersionCheck(t *testing.T) {
	_, srv, _ := newTestReceiver(t, nil)
	for _, path := range []string{"/v2", "/v2/"} {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: got %d, want 200", path, resp.StatusCode)
		}
		if got := resp.Header.Get("Docker-Distribution-Api-Version"); got != "registry/2.0" {
			t.Fatalf("api-version header: got %q", got)
		}
		if strings.TrimSpace(string(body)) != "{}" {
			t.Fatalf("body: got %q, want {}", string(body))
		}
	}
}

func TestBlobHeadForcesUpload(t *testing.T) {
	_, _, c := newTestReceiver(t, nil)
	resp := c.do(http.MethodHead, "/v2/"+c.repo+"/blobs/sha256:deadbeef", nil)
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("blob HEAD: got %d, want 404 (force upload)", resp.StatusCode)
	}
}

func TestMonolithicBlobRoundTrip(t *testing.T) {
	r, _, c := newTestReceiver(t, nil)
	content := []byte("compose-yaml-bytes")
	dgst := c.pushBlob(content)

	b, ok := r.Capture().GetBlob(dgst)
	if !ok {
		t.Fatal("blob not captured")
	}
	if !b.Retained || string(b.Bytes) != string(content) {
		t.Fatalf("blob bytes not retained: retained=%v", b.Retained)
	}

	get := c.do(http.MethodGet, "/v2/"+c.repo+"/blobs/"+dgst, nil)
	got, _ := io.ReadAll(get.Body)
	get.Body.Close()
	if string(got) != string(content) {
		t.Fatalf("blob GET: got %q, want %q", string(got), string(content))
	}
}

func TestChunkedBlobRoundTrip(t *testing.T) {
	r, _, c := newTestReceiver(t, nil)
	content := []byte("a-larger-chunked-blob-payload")
	dgst := c.pushBlobChunked(content)

	b, ok := r.Capture().GetBlob(dgst)
	if !ok || !b.Retained || string(b.Bytes) != string(content) {
		t.Fatalf("chunked blob not captured/retained: ok=%v", ok)
	}
}

func TestCappedBlobDiscardsBytesKeepsDigest(t *testing.T) {
	r := New(Options{MaxCaptureBytes: 8})
	srv := httptest.NewServer(http.HandlerFunc(r.handle))
	t.Cleanup(srv.Close)
	c := &pushClient{t: t, base: srv.URL, repo: "sam/test-one"}

	content := []byte("this-is-well-over-eight-bytes")
	dgst := c.pushBlob(content)

	b, ok := r.Capture().GetBlob(dgst)
	if !ok {
		t.Fatal("oversized blob not recorded")
	}
	if b.Retained {
		t.Fatal("oversized blob should not retain bytes")
	}
	if b.Size != int64(len(content)) {
		t.Fatalf("size: got %d, want %d", b.Size, len(content))
	}

	// GET on a non-retained blob is a miss.
	get := c.do(http.MethodGet, "/v2/"+c.repo+"/blobs/"+dgst, nil)
	get.Body.Close()
	if get.StatusCode != http.StatusNotFound {
		t.Fatalf("GET non-retained blob: got %d, want 404", get.StatusCode)
	}
}

// TestFullComposePublish exercises the complete publish flow: two YAML layers, an
// empty config blob, the compose project manifest, two service image manifests,
// the image index referrer, and the terminal tag push that fires the handler.
func TestFullComposePublish(t *testing.T) {
	var (
		mu       sync.Mutex
		captured *CapturedPublish
	)
	handler := func(_ context.Context, cp *CapturedPublish) error {
		mu.Lock()
		captured = cp
		mu.Unlock()
		return nil
	}
	_, _, c := newTestReceiver(t, handler)

	composeYAML := []byte("services:\n  web:\n    build: .\n  redis:\n    image: redis:7\n")
	digestsYAML := []byte("services:\n  web:\n    image: sam/test-one@sha256:web\n")
	emptyConfig := []byte("{}")

	composeDigest := c.pushBlob(composeYAML)
	digestsDigest := c.pushBlob(digestsYAML)
	configDigest := c.pushBlob(emptyConfig)

	// Service image manifests (their layer/config blobs are irrelevant to capture).
	webManifest := c.pushManifest("sha256:webmanifestref", Manifest{
		SchemaVersion: 2,
		MediaType:     MediaTypeImageManifest,
		Config:        &Descriptor{MediaType: "application/vnd.oci.image.config.v1+json", Digest: "sha256:webcfg"},
	})
	redisManifest := c.pushManifest("sha256:redismanifestref", Manifest{
		SchemaVersion: 2,
		MediaType:     MediaTypeImageManifest,
		Config:        &Descriptor{MediaType: "application/vnd.oci.image.config.v1+json", Digest: "sha256:rediscfg"},
	})

	// Compose project artifact manifest with the two YAML layers.
	projectDigest := c.pushManifest("sha256:projectref", Manifest{
		SchemaVersion: 2,
		MediaType:     MediaTypeImageManifest,
		ArtifactType:  ArtifactTypeComposeProject,
		Config:        &Descriptor{MediaType: "application/vnd.oci.empty.v1+json", Digest: configDigest, Size: int64(len(emptyConfig))},
		Layers: []Descriptor{
			{
				MediaType:   MediaTypeComposeFile,
				Digest:      composeDigest,
				Size:        int64(len(composeYAML)),
				Annotations: map[string]string{AnnotationComposeFile: ComposeFileBase},
			},
			{
				MediaType:   MediaTypeComposeFile,
				Digest:      digestsDigest,
				Size:        int64(len(digestsYAML)),
				Annotations: map[string]string{AnnotationComposeFile: ComposeFileDigests},
			},
		},
	})

	// Image index bundling the built service images, referring back to the project.
	c.pushManifest("sha256:indexref", Manifest{
		SchemaVersion: 2,
		MediaType:     MediaTypeImageIndex,
		Subject:       &Descriptor{MediaType: MediaTypeImageManifest, Digest: projectDigest},
		Manifests: []Descriptor{
			{
				MediaType:   MediaTypeImageManifest,
				Digest:      webManifest,
				Platform:    &Platform{Architecture: "amd64", OS: "linux"},
				Annotations: map[string]string{AnnotationComposeService: "web", AnnotationRefName: "sam/test-one:latest"},
			},
			{
				MediaType:   MediaTypeImageManifest,
				Digest:      redisManifest,
				Platform:    &Platform{Architecture: "amd64", OS: "linux"},
				Annotations: map[string]string{AnnotationComposeService: "redis"},
			},
		},
	})

	// Terminal tag push fires the publish handler.
	c.pushManifest("latest", Manifest{
		SchemaVersion: 2,
		MediaType:     MediaTypeImageIndex,
		Subject:       &Descriptor{MediaType: MediaTypeImageManifest, Digest: projectDigest},
		Manifests: []Descriptor{
			{MediaType: MediaTypeImageManifest, Digest: webManifest, Annotations: map[string]string{AnnotationComposeService: "web"}},
			{MediaType: MediaTypeImageManifest, Digest: redisManifest, Annotations: map[string]string{AnnotationComposeService: "redis"}},
		},
	})

	mu.Lock()
	cp := captured
	mu.Unlock()
	if cp == nil {
		t.Fatal("publish handler was never invoked on tag push")
	}
	if cp.Repository != "sam/test-one" || cp.Reference != "latest" {
		t.Fatalf("repo/ref: got %q/%q", cp.Repository, cp.Reference)
	}
	if cp.ProjectDigest != projectDigest {
		t.Fatalf("project digest: got %q, want %q", cp.ProjectDigest, projectDigest)
	}
	if string(cp.ComposeYAML) != string(composeYAML) {
		t.Fatalf("compose.yaml not captured: got %q", string(cp.ComposeYAML))
	}
	if string(cp.ImageDigestsYAML) != string(digestsYAML) {
		t.Fatalf("image-digests.yaml not captured: got %q", string(cp.ImageDigestsYAML))
	}
	if cp.ImageIndex == nil {
		t.Fatal("image index not captured")
	}
	if len(cp.Services) != 2 {
		t.Fatalf("services: got %d, want 2", len(cp.Services))
	}
	byName := map[string]ServiceImage{}
	for _, s := range cp.Services {
		byName[s.ServiceName] = s
	}
	if byName["web"].Digest != webManifest {
		t.Fatalf("web service digest: got %q, want %q", byName["web"].Digest, webManifest)
	}
	if byName["redis"].Digest != redisManifest {
		t.Fatalf("redis service digest: got %q, want %q", byName["redis"].Digest, redisManifest)
	}
}

func TestTagPushWithoutComposeProjectSkipsHandler(t *testing.T) {
	var called bool
	_, _, c := newTestReceiver(t, func(context.Context, *CapturedPublish) error {
		called = true
		return nil
	})
	c.pushManifest("latest", Manifest{SchemaVersion: 2, MediaType: MediaTypeImageManifest})
	if called {
		t.Fatal("handler fired without a compose project artifact")
	}
}

func TestParseV2Path(t *testing.T) {
	cases := []struct {
		path     string
		wantName string
		wantKind string
		wantRest string
		wantOK   bool
	}{
		{"/v2/sam/test-one/blobs/uploads/", "sam/test-one", kindBlobUpload, "", true},
		{"/v2/sam/test-one/blobs/uploads/abc-123", "sam/test-one", kindBlobUpload, "abc-123", true},
		{"/v2/sam/test-one/blobs/sha256:deadbeef", "sam/test-one", kindBlob, "sha256:deadbeef", true},
		{"/v2/sam/test-one/manifests/latest", "sam/test-one", kindManifest, "latest", true},
		{"/v2/a/b/c/manifests/sha256:x", "a/b/c", kindManifest, "sha256:x", true},
		{"/v2/", "", "", "", false},
		{"/healthz", "", "", "", false},
	}
	for _, tc := range cases {
		name, kind, rest, ok := parseV2Path(tc.path)
		if ok != tc.wantOK || name != tc.wantName || kind != tc.wantKind || rest != tc.wantRest {
			t.Errorf("parseV2Path(%q) = (%q,%q,%q,%v), want (%q,%q,%q,%v)",
				tc.path, name, kind, rest, ok, tc.wantName, tc.wantKind, tc.wantRest, tc.wantOK)
		}
	}
}
