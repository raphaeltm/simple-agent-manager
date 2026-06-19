package oci

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"sync"
)

// DefaultMaxCaptureBytes bounds the per-blob bytes retained in memory. Compose
// YAML layers and config blobs are tiny (a few KB); built image layers are large
// (hundreds of MB). We retain bytes only for blobs at or below this size and keep
// digest+size for the rest, so memory stays bounded regardless of image size.
const DefaultMaxCaptureBytes int64 = 1 << 20 // 1 MiB

// digest computes the OCI content digest ("sha256:<hex>") of b.
func digest(b []byte) string {
	sum := sha256.Sum256(b)
	return "sha256:" + hex.EncodeToString(sum[:])
}

// blobAccumulator streams blob bytes through a sha256 hash while retaining the
// bytes in memory only while the running total stays at or below cap. Once the
// total exceeds cap it discards the buffer and records size-only.
type blobAccumulator struct {
	hash   hash.Hash
	buf    bytes.Buffer
	total  int64
	cap    int64
	capped bool
}

func newBlobAccumulator(cap int64) *blobAccumulator {
	return &blobAccumulator{hash: sha256.New(), cap: cap}
}

// Write implements io.Writer; it never errors so the upload always drains.
func (a *blobAccumulator) Write(p []byte) (int, error) {
	a.hash.Write(p)
	a.total += int64(len(p))
	if !a.capped {
		if a.total <= a.cap {
			a.buf.Write(p)
		} else {
			a.capped = true
			a.buf.Reset()
		}
	}
	return len(p), nil
}

// Digest returns the OCI content digest of everything written so far.
func (a *blobAccumulator) Digest() string {
	return "sha256:" + hex.EncodeToString(a.hash.Sum(nil))
}

// Retained returns the buffered bytes and true when the blob fit within cap;
// otherwise nil and false (only Size() is meaningful).
func (a *blobAccumulator) Retained() ([]byte, bool) {
	if a.capped {
		return nil, false
	}
	return a.buf.Bytes(), true
}

// Size returns the total number of bytes written.
func (a *blobAccumulator) Size() int64 { return a.total }

// blob is a stored blob record. Bytes is nil when the blob exceeded the capture
// cap (Retained == false); Size is always recorded.
type blob struct {
	Digest   string
	Size     int64
	Retained bool
	Bytes    []byte
}

// manifestRecord is a stored manifest with its repository, the reference it was
// pushed under, and the raw + parsed forms.
type manifestRecord struct {
	Repository string
	Reference  string
	Digest     string
	Raw        []byte
	Manifest   *Manifest
}

// Capture is the bounded in-memory store of everything a publish uploads. It is
// safe for concurrent use; the receiver writes from request goroutines while the
// orchestrator reads on the OnPublishComplete callback.
type Capture struct {
	mu        sync.Mutex
	blobs     map[string]*blob           // digest -> blob
	manifests map[string]*manifestRecord // digest -> manifest
}

// NewCapture returns an empty capture store.
func NewCapture() *Capture {
	return &Capture{
		blobs:     make(map[string]*blob),
		manifests: make(map[string]*manifestRecord),
	}
}

// PutBlob records a finalized blob.
func (c *Capture) PutBlob(b *blob) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.blobs[b.Digest] = b
}

// GetBlob returns the stored blob for a digest, if any.
func (c *Capture) GetBlob(dgst string) (*blob, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	b, ok := c.blobs[dgst]
	return b, ok
}

// PutManifest records a manifest pushed under repo/reference.
func (c *Capture) PutManifest(rec *manifestRecord) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.manifests[rec.Digest] = rec
}

// GetManifest returns the stored manifest for a digest, if any.
func (c *Capture) GetManifest(dgst string) (*manifestRecord, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	rec, ok := c.manifests[dgst]
	return rec, ok
}

// AssembleComposePublish gathers the captured state for repo into a
// CapturedPublish. ref is the tag the publish targeted. It locates the compose
// project artifact, its two YAML layers, and the image index (preferring one
// whose subject points at the project manifest). Returns false if no compose
// project artifact has been captured for repo.
func (c *Capture) AssembleComposePublish(repo, ref string) (*CapturedPublish, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	var project *manifestRecord
	for _, rec := range c.manifests {
		if rec.Repository == repo && rec.Manifest.IsComposeProject() {
			project = rec
			break
		}
	}
	if project == nil {
		return nil, false
	}

	cp := &CapturedPublish{
		Repository:      repo,
		Reference:       ref,
		ProjectManifest: project.Manifest,
		ProjectDigest:   project.Digest,
	}

	if d := project.Manifest.ComposeLayer(ComposeFileBase); d != nil {
		if b, ok := c.blobs[d.Digest]; ok && b.Retained {
			cp.ComposeYAML = b.Bytes
		}
	}
	if d := project.Manifest.ComposeLayer(ComposeFileDigests); d != nil {
		if b, ok := c.blobs[d.Digest]; ok && b.Retained {
			cp.ImageDigestsYAML = b.Bytes
		}
	}

	cp.ImageIndex, cp.ImageIndexDigest = c.findImageIndexLocked(repo, project.Digest)
	if cp.ImageIndex != nil {
		cp.Services = servicesFromIndex(cp.ImageIndex)
	}

	return cp, true
}

// findImageIndexLocked returns the captured image index for repo, preferring one
// whose subject references projectDigest. Caller must hold c.mu.
func (c *Capture) findImageIndexLocked(repo, projectDigest string) (*Manifest, string) {
	var fallback *manifestRecord
	for _, rec := range c.manifests {
		if rec.Repository != repo || !rec.Manifest.IsImageIndex() {
			continue
		}
		if rec.Manifest.Subject != nil && rec.Manifest.Subject.Digest == projectDigest {
			return rec.Manifest, rec.Digest
		}
		if fallback == nil {
			fallback = rec
		}
	}
	if fallback != nil {
		return fallback.Manifest, fallback.Digest
	}
	return nil, ""
}

// servicesFromIndex extracts per-service image entries from an image index.
func servicesFromIndex(index *Manifest) []ServiceImage {
	services := make([]ServiceImage, 0, len(index.Manifests))
	for i := range index.Manifests {
		d := index.Manifests[i]
		// Skip attestation/referrer entries that are not platform images.
		if d.MediaType != MediaTypeImageManifest && d.MediaType != MediaTypeDockerManifest {
			continue
		}
		services = append(services, ServiceImage{
			Digest:      d.Digest,
			MediaType:   d.MediaType,
			Size:        d.Size,
			Platform:    d.Platform,
			ServiceName: d.Annotations[AnnotationComposeService],
			RefName:     d.Annotations[AnnotationRefName],
			Annotations: d.Annotations,
		})
	}
	return services
}
