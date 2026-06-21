package publish

import "strings"

// Platform describes the target platform of a built image.
type Platform struct {
	Architecture string `json:"architecture,omitempty"`
	OS           string `json:"os,omitempty"`
	Variant      string `json:"variant,omitempty"`
}

// BuiltService is a single compose service image built on the host docker
// daemon. LocalRef is the daemon-local image reference (the resolved compose
// `image:` value) the orchestrator re-tags and pushes into the project
// namespace.
type BuiltService struct {
	ServiceName string
	LocalRef    string
	Digest      string
	MediaType   string
	Size        int64
	Platform    *Platform
}

// BuildArtifact is the result of a host-side `docker compose build`. It is the
// input to the publish orchestrator, which re-tags and pushes each built
// service image into the project-scoped registry namespace and records a
// release.
type BuildArtifact struct {
	// Reference is the release tag the publish targets (e.g. "latest").
	Reference string
	// ComposeYAML is the resolved compose configuration bytes recorded with the
	// release.
	ComposeYAML []byte
	// Services are the per-service images built on the host.
	Services []BuiltService
}

// IsDigestReference reports whether a reference is a content digest
// (e.g. "sha256:...") rather than a human tag.
func IsDigestReference(ref string) bool {
	return strings.HasPrefix(ref, "sha256:")
}
