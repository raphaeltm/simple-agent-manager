// Package publish turns a captured `docker compose publish` artifact into a real
// release. When the OCI receiver (internal/oci) finishes capturing a publish, the
// orchestrator mints short-lived push credentials from the control plane, re-tags
// the built service images the agent pushed to the local receiver, pushes them
// into the project-scoped registry namespace ({accountId}/sam-{projectId}), and
// submits the captured compose topology + image digests as a release.
//
// The agent never receives the account-wide registry credential: the orchestrator
// runs inside the SAM-controlled vm-agent, mints scoped creds with its callback
// token, and re-pushes via the host docker daemon. Every hop emits structured
// logs so the staging flow can be iterated to a clean publish.
package publish

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/workspace/vm-agent/internal/oci"
)

// PushCredentials are the short-lived registry credentials minted by the control
// plane for a single publish. Values are never logged.
type PushCredentials struct {
	Registry  string `json:"registry"`
	Username  string `json:"username"`
	Password  string `json:"password"`
	Namespace string `json:"namespace"` // {accountId}/sam-{projectId}
	ExpiresAt string `json:"expiresAt"`
}

// ServiceRelease records one re-pushed service image for the release submission.
type ServiceRelease struct {
	ServiceName string        `json:"serviceName"`
	SourceRef   string        `json:"sourceRef"`
	PushedRef   string        `json:"pushedRef"`
	Digest      string        `json:"digest"`
	MediaType   string        `json:"mediaType,omitempty"`
	Size        int64         `json:"size,omitempty"`
	Platform    *oci.Platform `json:"platform,omitempty"`
}

// ReleaseSubmission is the payload sent to the control plane to record a release
// from a captured compose publish.
type ReleaseSubmission struct {
	Reference        string           `json:"reference"`
	ProjectDigest    string           `json:"projectDigest"`
	ImageIndexDigest string           `json:"imageIndexDigest,omitempty"`
	ComposeYAML      string           `json:"composeYaml"`
	ImageDigestsYAML string           `json:"imageDigestsYaml,omitempty"`
	Services         []ServiceRelease `json:"services"`
}

// ReleaseResult is the control plane's response to a release submission.
type ReleaseResult struct {
	ReleaseID string `json:"releaseId"`
	Version   int    `json:"version"`
	Status    string `json:"status"`
}

// ControlPlane mints push credentials and submits the captured release.
type ControlPlane interface {
	MintPushCredentials(ctx context.Context, projectID string) (*PushCredentials, error)
	SubmitRelease(ctx context.Context, projectID string, req *ReleaseSubmission) (*ReleaseResult, error)
}

// Docker logs into a registry and re-tags + pushes images via the host daemon.
type Docker interface {
	Login(ctx context.Context, registry, username, password string) error
	Tag(ctx context.Context, source, target string) error
	Push(ctx context.Context, ref string) (digest string, err error)
}

// Options configures a new Orchestrator.
type Options struct {
	ControlPlane ControlPlane
	Docker       Docker
	// PublishHost is the registry hostname the agent pushed to (the local
	// receiver, e.g. "sam-registry.local:5050"). It is the source side of the
	// re-tag: the built images live in the host daemon as
	// {PublishHost}/{repository}@{digest}.
	PublishHost string
	Logger      *slog.Logger
}

// Orchestrator drives the post-capture publish flow.
type Orchestrator struct {
	controlPlane ControlPlane
	docker       Docker
	publishHost  string
	log          *slog.Logger
}

// New constructs an Orchestrator. ControlPlane and Docker are required.
func New(opts Options) *Orchestrator {
	log := opts.Logger
	if log == nil {
		log = slog.Default()
	}
	return &Orchestrator{
		controlPlane: opts.ControlPlane,
		docker:       opts.Docker,
		publishHost:  opts.PublishHost,
		log:          log.With("component", "publish-orchestrator"),
	}
}

// Publish re-pushes the captured built images into the project namespace and
// records a release. It is the OnPublish callback the receiver fires on a
// completed publish.
func (o *Orchestrator) Publish(ctx context.Context, projectID string, cp *oci.CapturedPublish) (*ReleaseResult, error) {
	if cp == nil {
		return nil, fmt.Errorf("publish: nil captured publish")
	}
	if projectID == "" {
		return nil, fmt.Errorf("publish: empty projectID")
	}

	o.log.Info("publish started",
		"projectId", projectID,
		"repository", cp.Repository,
		"reference", cp.Reference,
		"projectDigest", cp.ProjectDigest,
		"imageIndexDigest", cp.ImageIndexDigest,
		"serviceCount", len(cp.Services),
		"composeYamlBytes", len(cp.ComposeYAML),
		"imageDigestsYamlBytes", len(cp.ImageDigestsYAML))

	creds, err := o.controlPlane.MintPushCredentials(ctx, projectID)
	if err != nil {
		return nil, fmt.Errorf("publish: mint push credentials: %w", err)
	}
	o.log.Info("push credentials minted",
		"projectId", projectID,
		"registry", creds.Registry,
		"namespace", creds.Namespace,
		"expiresAt", creds.ExpiresAt)

	if err := o.docker.Login(ctx, creds.Registry, creds.Username, creds.Password); err != nil {
		return nil, fmt.Errorf("publish: docker login %s: %w", creds.Registry, err)
	}
	o.log.Info("registry login succeeded", "registry", creds.Registry)

	services, err := o.repushServices(ctx, cp, creds)
	if err != nil {
		return nil, err
	}

	submission := &ReleaseSubmission{
		Reference:        cp.Reference,
		ProjectDigest:    cp.ProjectDigest,
		ImageIndexDigest: cp.ImageIndexDigest,
		ComposeYAML:      string(cp.ComposeYAML),
		ImageDigestsYAML: string(cp.ImageDigestsYAML),
		Services:         services,
	}

	result, err := o.controlPlane.SubmitRelease(ctx, projectID, submission)
	if err != nil {
		return nil, fmt.Errorf("publish: submit release: %w", err)
	}
	o.log.Info("release recorded",
		"projectId", projectID,
		"releaseId", result.ReleaseID,
		"version", result.Version,
		"status", result.Status,
		"services", len(services))

	return result, nil
}

// repushServices re-tags each captured built service image into the project
// namespace and pushes it. The source images are content-addressed in the host
// daemon by the digest the receiver recorded, so re-tagging preserves the digest.
func (o *Orchestrator) repushServices(ctx context.Context, cp *oci.CapturedPublish, creds *PushCredentials) ([]ServiceRelease, error) {
	releases := make([]ServiceRelease, 0, len(cp.Services))
	for i := range cp.Services {
		svc := cp.Services[i]
		serviceName := serviceSlug(svc, i)
		sourceRepo := svc.Repository
		if sourceRepo == "" {
			sourceRepo = cp.Repository
		}
		source := o.sourceRef(sourceRepo, svc.Digest)
		if svc.Repository != "" && svc.RefName != "" {
			source = o.sourceTagRef(svc.RefName)
		}
		target := targetRef(creds, serviceName, cp.Reference)

		o.log.Info("re-pushing service image",
			"service", serviceName,
			"source", source,
			"target", target,
			"capturedDigest", svc.Digest,
			"mediaType", svc.MediaType,
			"size", svc.Size)

		if err := o.docker.Tag(ctx, source, target); err != nil {
			return nil, fmt.Errorf("publish: tag %s -> %s: %w", source, target, err)
		}

		pushedDigest, err := o.docker.Push(ctx, target)
		if err != nil {
			return nil, fmt.Errorf("publish: push %s: %w", target, err)
		}

		// The re-tag preserves content, so the pushed digest should equal the
		// captured digest. Warn (don't fail) on divergence so staging surfaces it.
		if pushedDigest != "" && svc.Digest != "" && pushedDigest != svc.Digest {
			o.log.Warn("pushed digest differs from captured digest",
				"service", serviceName,
				"capturedDigest", svc.Digest,
				"pushedDigest", pushedDigest)
		}
		digest := pushedDigest
		if digest == "" {
			digest = svc.Digest
		}

		o.log.Info("service image pushed",
			"service", serviceName,
			"target", target,
			"digest", digest)

		releases = append(releases, ServiceRelease{
			ServiceName: serviceName,
			SourceRef:   source,
			PushedRef:   pinnedRef(target, digest),
			Digest:      digest,
			MediaType:   svc.MediaType,
			Size:        svc.Size,
			Platform:    svc.Platform,
		})
	}
	return releases, nil
}

// sourceRef is the host-daemon reference for a captured built image. After
// `docker compose publish`, the daemon holds each built image with a repo-digest
// of {publishHost}/{repository}@{digest}.
func (o *Orchestrator) sourceRef(repository, digest string) string {
	repo := repository
	if o.publishHost != "" {
		repo = o.publishHost + "/" + repository
	}
	return repo + "@" + digest
}

// sourceTagRef is the host-daemon tag reference for a service image pushed as
// its own child repository (for example "crewai/app:latest"). In that shape the
// daemon already has the tag locally, which is more reliable than assuming the
// tag's image-index digest is addressable as a local repo-digest.
func (o *Orchestrator) sourceTagRef(refName string) string {
	if o.publishHost == "" || hasRegistryHost(refName) {
		return refName
	}
	return o.publishHost + "/" + refName
}

func hasRegistryHost(ref string) bool {
	first, _, _ := strings.Cut(ref, "/")
	return strings.Contains(first, ".") || strings.Contains(first, ":") || first == "localhost"
}

// targetRef is the project-namespace reference for a re-pushed service image.
// CF registry paths are {registry}/{accountId}/{repository}:{tag}; the namespace
// already carries {accountId}/sam-{projectId}, so each service appends "-{name}".
func targetRef(creds *PushCredentials, serviceName, reference string) string {
	tag := reference
	if tag == "" || oci.IsDigestReference(tag) {
		tag = "latest"
	}
	return fmt.Sprintf("%s/%s-%s:%s", creds.Registry, creds.Namespace, serviceName, tag)
}

// pinnedRef rewrites a tagged ref to a digest-pinned ref for the release record.
func pinnedRef(taggedRef, digest string) string {
	if digest == "" {
		return taggedRef
	}
	if idx := strings.LastIndex(taggedRef, ":"); idx != -1 {
		if slash := strings.LastIndex(taggedRef, "/"); slash < idx {
			return taggedRef[:idx] + "@" + digest
		}
	}
	return taggedRef + "@" + digest
}

// serviceSlug derives a stable, registry-safe service name. It prefers the
// compose service annotation, then the OCI ref-name, then a positional fallback.
func serviceSlug(svc oci.ServiceImage, index int) string {
	name := svc.ServiceName
	if name == "" {
		name = svc.RefName
	}
	name = sanitizeServiceName(name)
	if name == "" {
		name = fmt.Sprintf("service-%d", index)
	}
	return name
}

// sanitizeServiceName lowercases and reduces a name to the registry path charset
// [a-z0-9-], collapsing runs of invalid characters into single hyphens.
func sanitizeServiceName(s string) string {
	var b strings.Builder
	prevHyphen := false
	for _, r := range strings.ToLower(s) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevHyphen = false
		default:
			if !prevHyphen && b.Len() > 0 {
				b.WriteByte('-')
				prevHyphen = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
