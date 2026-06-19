package oci

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

// PublishHandler is invoked when a `docker compose publish` completes (signalled
// by a tag manifest push). It runs synchronously on the request goroutine before
// the receiver acknowledges the final push, so any returned error can be logged;
// the push itself still succeeds so the client sees a clean publish.
type PublishHandler func(ctx context.Context, cp *CapturedPublish) error

// Receiver implements the OCI Distribution v2 push-protocol subset that
// `docker compose publish` exercises and captures the resulting artifact. It is
// served over TLS on host loopback by Start.
type Receiver struct {
	capture         *Capture
	maxCaptureBytes int64
	log             *slog.Logger

	onPublish PublishHandler

	mu       sync.Mutex
	uploads  map[string]*pendingUpload
	server   *http.Server
	listener net.Listener
}

// pendingUpload tracks an in-flight chunked blob upload between POST/PATCH/PUT.
type pendingUpload struct {
	repository string
	acc        *blobAccumulator
}

// Options configures a Receiver.
type Options struct {
	// MaxCaptureBytes bounds per-blob in-memory retention; defaults to
	// DefaultMaxCaptureBytes when zero.
	MaxCaptureBytes int64
	// Logger receives structured logs; defaults to slog.Default().
	Logger *slog.Logger
	// OnPublish is called when a publish completes. Optional.
	OnPublish PublishHandler
}

// New constructs a Receiver.
func New(opts Options) *Receiver {
	maxBytes := opts.MaxCaptureBytes
	if maxBytes <= 0 {
		maxBytes = DefaultMaxCaptureBytes
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	return &Receiver{
		capture:         NewCapture(),
		maxCaptureBytes: maxBytes,
		log:             logger.With("component", "oci-receiver"),
		onPublish:       opts.OnPublish,
		uploads:         make(map[string]*pendingUpload),
	}
}

// Capture exposes the underlying capture store (primarily for tests and the
// orchestrator).
func (r *Receiver) Capture() *Capture { return r.capture }

// Start serves the receiver over TLS on addr (host loopback, e.g.
// "127.0.0.1:5050") using the cert/key at certPath/keyPath. It blocks until the
// listener fails or Stop is called; http.ErrServerClosed is returned on clean
// shutdown and should be treated as success by the caller.
func (r *Receiver) Start(addr, certPath, keyPath string) error {
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("oci receiver: listen %s: %w", addr, err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", r.handle)

	r.mu.Lock()
	r.listener = ln
	r.server = &http.Server{
		Handler:      mux,
		ReadTimeout:  30 * time.Minute,
		WriteTimeout: 30 * time.Minute,
		IdleTimeout:  5 * time.Minute,
	}
	srv := r.server
	r.mu.Unlock()

	r.log.Info("oci receiver listening", "addr", addr, "tls", true)
	return srv.ServeTLS(ln, certPath, keyPath)
}

// Stop gracefully shuts the receiver down.
func (r *Receiver) Stop(ctx context.Context) error {
	r.mu.Lock()
	srv := r.server
	r.mu.Unlock()
	if srv == nil {
		return nil
	}
	return srv.Shutdown(ctx)
}

// handle is the single entry point; OCI repository names contain slashes, which
// the stdlib ServeMux cannot express as a mid-pattern wildcard, so we route by
// parsing the path ourselves.
func (r *Receiver) handle(w http.ResponseWriter, req *http.Request) {
	path := req.URL.Path

	// Version check: GET/HEAD /v2/ -> 200 with the api-version header.
	if path == "/v2" || path == "/v2/" {
		w.Header().Set("Docker-Distribution-Api-Version", "registry/2.0")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
		r.log.Info("v2 version check", "method", req.Method)
		return
	}

	name, kind, rest, ok := parseV2Path(path)
	if !ok {
		r.unhandled(w, req)
		return
	}

	switch kind {
	case kindBlobUpload:
		r.handleBlobUpload(w, req, name, rest)
	case kindBlob:
		r.handleBlob(w, req, name, rest)
	case kindManifest:
		r.handleManifest(w, req, name, rest)
	default:
		r.unhandled(w, req)
	}
}

const (
	kindBlobUpload = "blob-upload"
	kindBlob       = "blob"
	kindManifest   = "manifest"
)

// parseV2Path splits "/v2/<name>/{blobs/uploads|blobs|manifests}/<rest>" where
// <name> may contain slashes. Upload markers are tested before the blob marker
// because "/blobs/uploads/" contains "/blobs/".
func parseV2Path(p string) (name, kind, rest string, ok bool) {
	if !strings.HasPrefix(p, "/v2/") {
		return "", "", "", false
	}
	rem := p[len("/v2/"):]

	if i := strings.Index(rem, "/blobs/uploads/"); i >= 0 {
		return rem[:i], kindBlobUpload, rem[i+len("/blobs/uploads/"):], true
	}
	if strings.HasSuffix(rem, "/blobs/uploads") {
		return rem[:len(rem)-len("/blobs/uploads")], kindBlobUpload, "", true
	}
	if i := strings.Index(rem, "/blobs/"); i >= 0 {
		return rem[:i], kindBlob, rem[i+len("/blobs/"):], true
	}
	if i := strings.Index(rem, "/manifests/"); i >= 0 {
		return rem[:i], kindManifest, rem[i+len("/manifests/"):], true
	}
	return "", "", "", false
}

// handleBlobUpload covers POST (start / monolithic), PATCH (append chunk), and
// PUT (finalize) on /v2/<name>/blobs/uploads/<uuid>.
func (r *Receiver) handleBlobUpload(w http.ResponseWriter, req *http.Request, name, uploadID string) {
	switch req.Method {
	case http.MethodPost:
		r.startOrMonolithicUpload(w, req, name)
	case http.MethodPatch:
		r.appendChunk(w, req, name, uploadID)
	case http.MethodPut:
		r.finalizeUpload(w, req, name, uploadID)
	default:
		r.unhandled(w, req)
	}
}

// startOrMonolithicUpload handles POST .../blobs/uploads/. With ?digest= (and no
// cross-repo mount) it is a monolithic upload finalized immediately; otherwise it
// begins a chunked session. A ?mount= request is treated as a miss so the client
// re-uploads the blob and we capture it.
func (r *Receiver) startOrMonolithicUpload(w http.ResponseWriter, req *http.Request, name string) {
	q := req.URL.Query()
	mount := q.Get("mount")
	dgst := q.Get("digest")

	if dgst != "" && mount == "" {
		acc := newBlobAccumulator(r.maxCaptureBytes)
		if _, err := io.Copy(acc, req.Body); err != nil {
			r.fail(w, req, "read monolithic blob", err)
			return
		}
		r.storeBlob(name, acc, dgst, "monolithic")
		w.Header().Set("Location", "/v2/"+name+"/blobs/"+acc.Digest())
		w.Header().Set("Docker-Content-Digest", acc.Digest())
		w.WriteHeader(http.StatusCreated)
		return
	}

	id := uuid.NewString()
	r.mu.Lock()
	r.uploads[id] = &pendingUpload{repository: name, acc: newBlobAccumulator(r.maxCaptureBytes)}
	r.mu.Unlock()

	w.Header().Set("Location", "/v2/"+name+"/blobs/uploads/"+id)
	w.Header().Set("Docker-Upload-Uuid", id)
	w.Header().Set("Range", "0-0")
	w.WriteHeader(http.StatusAccepted)
	r.log.Info("blob upload started", "repository", name, "uploadId", id, "mount", mount != "")
}

// appendChunk handles PATCH .../blobs/uploads/<uuid>.
func (r *Receiver) appendChunk(w http.ResponseWriter, req *http.Request, name, uploadID string) {
	r.mu.Lock()
	up := r.uploads[uploadID]
	r.mu.Unlock()
	if up == nil {
		r.log.Warn("patch for unknown upload", "repository", name, "uploadId", uploadID)
		http.Error(w, "unknown upload", http.StatusNotFound)
		return
	}

	before := up.acc.Size()
	if _, err := io.Copy(up.acc, req.Body); err != nil {
		r.fail(w, req, "read chunk", err)
		return
	}
	total := up.acc.Size()

	w.Header().Set("Location", "/v2/"+name+"/blobs/uploads/"+uploadID)
	w.Header().Set("Docker-Upload-Uuid", uploadID)
	if total > 0 {
		w.Header().Set("Range", fmt.Sprintf("0-%d", total-1))
	} else {
		w.Header().Set("Range", "0-0")
	}
	w.WriteHeader(http.StatusAccepted)
	r.log.Info("blob chunk appended", "repository", name, "uploadId", uploadID,
		"chunkBytes", total-before, "totalBytes", total)
}

// finalizeUpload handles PUT .../blobs/uploads/<uuid>?digest=. Any body is the
// final chunk and is appended before finalizing.
func (r *Receiver) finalizeUpload(w http.ResponseWriter, req *http.Request, name, uploadID string) {
	r.mu.Lock()
	up := r.uploads[uploadID]
	r.mu.Unlock()
	if up == nil {
		r.log.Warn("put for unknown upload", "repository", name, "uploadId", uploadID)
		http.Error(w, "unknown upload", http.StatusNotFound)
		return
	}

	if req.Body != nil {
		if _, err := io.Copy(up.acc, req.Body); err != nil {
			r.fail(w, req, "read final chunk", err)
			return
		}
	}
	claimed := req.URL.Query().Get("digest")
	r.storeBlob(name, up.acc, claimed, "chunked")

	r.mu.Lock()
	delete(r.uploads, uploadID)
	r.mu.Unlock()

	w.Header().Set("Location", "/v2/"+name+"/blobs/"+up.acc.Digest())
	w.Header().Set("Docker-Content-Digest", up.acc.Digest())
	w.WriteHeader(http.StatusCreated)
}

// storeBlob records a finalized blob and logs a digest-mismatch warning when the
// client's claimed digest disagrees with the computed one.
func (r *Receiver) storeBlob(name string, acc *blobAccumulator, claimed, mode string) {
	computed := acc.Digest()
	bytes, retained := acc.Retained()
	r.capture.PutBlob(&blob{
		Digest:   computed,
		Size:     acc.Size(),
		Retained: retained,
		Bytes:    bytes,
	})
	if claimed != "" && claimed != computed {
		r.log.Warn("blob digest mismatch", "repository", name,
			"claimed", claimed, "computed", computed)
	}
	r.log.Info("blob stored", "repository", name, "mode", mode,
		"digest", computed, "size", acc.Size(), "retained", retained)
}

// handleBlob covers HEAD/GET /v2/<name>/blobs/<digest>. HEAD returns 404 to force
// the client to upload (so we capture every blob), matching the spike. GET serves
// retained bytes when present.
func (r *Receiver) handleBlob(w http.ResponseWriter, req *http.Request, name, dgst string) {
	switch req.Method {
	case http.MethodHead:
		w.WriteHeader(http.StatusNotFound)
		r.log.Info("blob HEAD -> 404 (force upload)", "repository", name, "digest", dgst)
	case http.MethodGet:
		b, ok := r.capture.GetBlob(dgst)
		if !ok || !b.Retained {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		w.Header().Set("Docker-Content-Digest", b.Digest)
		w.Header().Set("Content-Type", "application/octet-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(b.Bytes)
	default:
		r.unhandled(w, req)
	}
}

// handleManifest covers PUT/HEAD/GET /v2/<name>/manifests/<reference>.
func (r *Receiver) handleManifest(w http.ResponseWriter, req *http.Request, name, reference string) {
	switch req.Method {
	case http.MethodPut:
		r.putManifest(w, req, name, reference)
	case http.MethodHead, http.MethodGet:
		r.getManifest(w, req, name, reference)
	default:
		r.unhandled(w, req)
	}
}

// putManifest stores a manifest by digest (and tag->digest), parses its topology,
// and — when pushed under a tag (the terminal publish operation) — assembles the
// captured publish and invokes the publish handler.
func (r *Receiver) putManifest(w http.ResponseWriter, req *http.Request, name, reference string) {
	raw, err := io.ReadAll(req.Body)
	if err != nil {
		r.fail(w, req, "read manifest", err)
		return
	}
	dgst := digest(raw)

	var m Manifest
	if err := json.Unmarshal(raw, &m); err != nil {
		r.fail(w, req, "parse manifest", err)
		return
	}

	r.capture.PutManifest(&manifestRecord{
		Repository: name,
		Reference:  reference,
		Digest:     dgst,
		Raw:        raw,
		Manifest:   &m,
	})

	sum := m.Summarize()
	r.log.Info("manifest stored", "repository", name, "reference", reference,
		"digest", dgst, "mediaType", sum.MediaType, "artifactType", sum.ArtifactType,
		"layers", sum.LayerCount, "manifests", sum.ManifestCount,
		"composeFiles", sum.ComposeFiles)

	// A tag push (non-digest reference) is the terminal operation of
	// `docker compose publish`: by now every blob and manifest is present.
	if !IsDigestReference(reference) {
		r.completePublish(req.Context(), name, reference, req.RemoteAddr)
	}

	w.Header().Set("Docker-Content-Digest", dgst)
	w.WriteHeader(http.StatusCreated)
}

// completePublish assembles the captured publish for repo and invokes the handler.
func (r *Receiver) completePublish(ctx context.Context, name, reference, remoteAddr string) {
	cp, ok := r.capture.AssembleComposePublish(name, reference)
	if !ok {
		r.log.Info("tag pushed but no compose project artifact captured; skipping publish handler",
			"repository", name, "reference", reference)
		return
	}
	cp.SourceRemoteAddr = strings.TrimSpace(remoteAddr)
	cp.SourceIP = remoteIPFromAddr(remoteAddr)

	r.log.Info("publish captured", "repository", name, "reference", reference,
		"projectDigest", cp.ProjectDigest, "composeYamlBytes", len(cp.ComposeYAML),
		"imageDigestsYamlBytes", len(cp.ImageDigestsYAML), "imageIndexDigest", cp.ImageIndexDigest,
		"services", len(cp.Services), "sourceIP", cp.SourceIP)

	if r.onPublish == nil {
		return
	}
	if err := r.onPublish(ctx, cp); err != nil {
		r.log.Error("publish handler failed", "repository", name, "reference", reference,
			"error", err)
	}
}

func remoteIPFromAddr(remoteAddr string) string {
	trimmed := strings.TrimSpace(remoteAddr)
	if trimmed == "" {
		return ""
	}
	host, _, err := net.SplitHostPort(trimmed)
	if err == nil {
		trimmed = host
	}
	trimmed = strings.Trim(trimmed, "[]")
	if ip := net.ParseIP(trimmed); ip != nil {
		return ip.String()
	}
	return trimmed
}

// getManifest serves a stored manifest by digest or, for a tag, the most recent
// manifest pushed under that reference.
func (r *Receiver) getManifest(w http.ResponseWriter, req *http.Request, name, reference string) {
	rec, ok := r.lookupManifest(name, reference)
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	contentType := rec.Manifest.MediaType
	if contentType == "" {
		contentType = MediaTypeImageManifest
	}
	w.Header().Set("Docker-Content-Digest", rec.Digest)
	w.Header().Set("Content-Type", contentType)
	if req.Method == http.MethodHead {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", len(rec.Raw)))
		w.WriteHeader(http.StatusOK)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(rec.Raw)
}

// lookupManifest resolves reference as a digest first, then as a tag pushed under
// repo.
func (r *Receiver) lookupManifest(name, reference string) (*manifestRecord, bool) {
	if IsDigestReference(reference) {
		return r.capture.GetManifest(reference)
	}
	r.capture.mu.Lock()
	defer r.capture.mu.Unlock()
	for _, rec := range r.capture.manifests {
		if rec.Repository == name && rec.Reference == reference {
			return rec, true
		}
	}
	return nil, false
}

// unhandled logs an unrecognized request and returns 404.
func (r *Receiver) unhandled(w http.ResponseWriter, req *http.Request) {
	r.log.Warn("unhandled request", "method", req.Method, "url", req.URL.String(),
		"contentLength", req.ContentLength)
	w.WriteHeader(http.StatusNotFound)
}

// fail logs an internal error and returns 500.
func (r *Receiver) fail(w http.ResponseWriter, req *http.Request, op string, err error) {
	r.log.Error("receiver error", "op", op, "method", req.Method, "url", req.URL.String(),
		"error", err)
	http.Error(w, "internal error", http.StatusInternalServerError)
}
