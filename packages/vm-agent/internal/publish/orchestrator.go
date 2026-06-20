// Package publish turns a host-side `docker compose build` artifact into a real
// release. The vm-agent builds the workspace's compose services on the host
// docker daemon, then the orchestrator mints short-lived push credentials from
// the control plane, re-tags the built service images into the project-scoped
// registry namespace ({accountId}/sam-{projectId}), pushes them, and submits the
// captured compose topology + image digests as a release.
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
	ServiceName string    `json:"serviceName"`
	SourceRef   string    `json:"sourceRef"`
	PushedRef   string    `json:"pushedRef"`
	Digest      string    `json:"digest"`
	MediaType   string    `json:"mediaType,omitempty"`
	Size        int64     `json:"size,omitempty"`
	Platform    *Platform `json:"platform,omitempty"`
}

// ReleaseSubmission is the payload sent to the control plane to record a release
// from a host-built compose artifact.
type ReleaseSubmission struct {
	Reference   string           `json:"reference"`
	ComposeYAML string           `json:"composeYaml"`
	Services    []ServiceRelease `json:"services"`
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
	Logger       *slog.Logger
}

// Orchestrator drives the post-build publish flow.
type Orchestrator struct {
	controlPlane ControlPlane
	docker       Docker
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
		log:          log.With("component", "publish-orchestrator"),
	}
}

// Publish re-pushes the host-built images into the project namespace and records
// a release.
func (o *Orchestrator) Publish(ctx context.Context, projectID string, art *BuildArtifact) (*ReleaseResult, error) {
	if art == nil {
		return nil, fmt.Errorf("publish: nil build artifact")
	}
	if projectID == "" {
		return nil, fmt.Errorf("publish: empty projectID")
	}

	o.log.Info("publish started",
		"projectId", projectID,
		"reference", art.Reference,
		"serviceCount", len(art.Services),
		"composeYamlBytes", len(art.ComposeYAML))

	creds, err := o.controlPlane.MintPushCredentials(ctx, projectID)
	if err != nil {
		o.log.Error("mint push credentials failed", "projectId", projectID, "error", err)
		return nil, fmt.Errorf("publish: mint push credentials: %w", err)
	}
	o.log.Info("push credentials minted",
		"projectId", projectID,
		"registry", creds.Registry,
		"namespace", creds.Namespace,
		"expiresAt", creds.ExpiresAt)

	if err := o.docker.Login(ctx, creds.Registry, creds.Username, creds.Password); err != nil {
		o.log.Error("registry login failed", "registry", creds.Registry, "error", err)
		return nil, fmt.Errorf("publish: docker login %s: %w", creds.Registry, err)
	}
	o.log.Info("registry login succeeded", "registry", creds.Registry)

	services, err := o.repushServices(ctx, art, creds)
	if err != nil {
		o.log.Error("re-push services failed", "projectId", projectID, "error", err)
		return nil, err
	}

	submission := &ReleaseSubmission{
		Reference:   art.Reference,
		ComposeYAML: string(art.ComposeYAML),
		Services:    services,
	}

	result, err := o.controlPlane.SubmitRelease(ctx, projectID, submission)
	if err != nil {
		o.log.Error("submit release failed",
			"projectId", projectID,
			"reference", art.Reference,
			"services", len(services),
			"error", err)
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

// repushServices re-tags each host-built service image into the project
// namespace and pushes it. The source images are present in the host daemon by
// their resolved compose `image:` reference.
func (o *Orchestrator) repushServices(ctx context.Context, art *BuildArtifact, creds *PushCredentials) ([]ServiceRelease, error) {
	releases := make([]ServiceRelease, 0, len(art.Services))
	for i := range art.Services {
		svc := art.Services[i]
		serviceName := serviceSlug(svc, i)
		source := svc.LocalRef
		target := targetRef(creds, serviceName, art.Reference)

		o.log.Info("re-pushing service image",
			"service", serviceName,
			"source", source,
			"target", target,
			"builtDigest", svc.Digest,
			"mediaType", svc.MediaType,
			"size", svc.Size)

		if err := o.docker.Tag(ctx, source, target); err != nil {
			o.log.Error("docker tag failed",
				"service", serviceName, "source", source, "target", target, "error", err)
			return nil, fmt.Errorf("publish: tag %s -> %s: %w", source, target, err)
		}

		pushedDigest, err := o.docker.Push(ctx, target)
		if err != nil {
			o.log.Error("docker push failed",
				"service", serviceName, "target", target, "error", err)
			return nil, fmt.Errorf("publish: push %s: %w", target, err)
		}

		// The re-tag preserves content, so the pushed digest should equal the
		// built digest. Warn (don't fail) on divergence so staging surfaces it.
		if pushedDigest != "" && svc.Digest != "" && pushedDigest != svc.Digest {
			o.log.Warn("pushed digest differs from built digest",
				"service", serviceName,
				"builtDigest", svc.Digest,
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

// targetRef is the project-namespace reference for a re-pushed service image.
// CF registry paths are {registry}/{accountId}/{repository}:{tag}; the namespace
// already carries {accountId}/sam-{projectId}, so each service appends "-{name}".
func targetRef(creds *PushCredentials, serviceName, reference string) string {
	tag := reference
	if tag == "" || IsDigestReference(tag) {
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
// compose service name, then a positional fallback.
func serviceSlug(svc BuiltService, index int) string {
	name := sanitizeServiceName(svc.ServiceName)
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
