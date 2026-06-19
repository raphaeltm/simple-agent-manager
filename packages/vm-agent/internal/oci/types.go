// Package oci implements a minimal OCI Distribution v2 registry receiver.
//
// It exists to capture the artifact produced by `docker compose publish` running
// inside a SAM workspace devcontainer. The receiver is SAM-controlled and serves
// on host loopback; the coding agent cannot redirect its push elsewhere. On
// receipt of a full publish it surfaces the captured compose topology and the two
// compose YAML layers (compose.yaml + the digest-pinned image-digests.yaml) plus
// the OCI image index that bundles the built service images, so the publish
// orchestrator can re-push the built images into the project-scoped registry
// namespace and record a release.
//
// Only the push-protocol subset that `docker compose publish` exercises is
// implemented (see receiver.go). This mirrors the proven spike in
// experiments/compose-publish-oci-proxy/.
package oci

import "strings"

// Media types used by the OCI distribution and docker compose artifact specs.
const (
	// MediaTypeImageIndex is the OCI image index that bundles service images.
	MediaTypeImageIndex = "application/vnd.oci.image.index.v1+json"
	// MediaTypeImageManifest is a single-platform OCI image manifest.
	MediaTypeImageManifest = "application/vnd.oci.image.manifest.v1+json"
	// MediaTypeDockerManifestList is the legacy docker manifest list.
	MediaTypeDockerManifestList = "application/vnd.docker.distribution.manifest.list.v2+json"
	// MediaTypeDockerManifest is the legacy docker image manifest.
	MediaTypeDockerManifest = "application/vnd.docker.distribution.manifest.v2+json"

	// ArtifactTypeComposeProject identifies the top-level compose project artifact.
	ArtifactTypeComposeProject = "application/vnd.docker.compose.project"
	// MediaTypeComposeFile is the layer media type for a compose YAML file.
	MediaTypeComposeFile = "application/vnd.docker.compose.file+yaml"

	// AnnotationComposeFile names the compose file a YAML layer carries
	// (e.g. "compose.yaml" or "image-digests.yaml").
	AnnotationComposeFile = "com.docker.compose.file"
	// AnnotationComposeService names the compose service an image entry belongs to.
	AnnotationComposeService = "com.docker.compose.service"
	// AnnotationRefName is the standard OCI image ref-name annotation.
	AnnotationRefName = "org.opencontainers.image.ref.name"

	// Well-known compose YAML layer file names.
	ComposeFileBase    = "compose.yaml"
	ComposeFileDigests = "image-digests.yaml"
)

// Platform describes the target platform of an image manifest descriptor.
type Platform struct {
	Architecture string `json:"architecture,omitempty"`
	OS           string `json:"os,omitempty"`
	Variant      string `json:"variant,omitempty"`
}

// Descriptor is an OCI content descriptor (config, layer, or manifest entry).
type Descriptor struct {
	MediaType    string            `json:"mediaType,omitempty"`
	ArtifactType string            `json:"artifactType,omitempty"`
	Digest       string            `json:"digest,omitempty"`
	Size         int64             `json:"size,omitempty"`
	Platform     *Platform         `json:"platform,omitempty"`
	Annotations  map[string]string `json:"annotations,omitempty"`
}

// Manifest is an OCI manifest, image index, or compose project artifact. The
// union of fields covers every shape the compose publish flow produces; absent
// fields stay nil/empty after JSON decode.
type Manifest struct {
	SchemaVersion int               `json:"schemaVersion,omitempty"`
	MediaType     string            `json:"mediaType,omitempty"`
	ArtifactType  string            `json:"artifactType,omitempty"`
	Config        *Descriptor       `json:"config,omitempty"`
	Layers        []Descriptor      `json:"layers,omitempty"`
	Manifests     []Descriptor      `json:"manifests,omitempty"`
	Subject       *Descriptor       `json:"subject,omitempty"`
	Annotations   map[string]string `json:"annotations,omitempty"`
}

// IsComposeProject reports whether this manifest is the top-level compose
// project artifact.
func (m *Manifest) IsComposeProject() bool {
	return m != nil && m.ArtifactType == ArtifactTypeComposeProject
}

// IsImageIndex reports whether this manifest is an OCI image index or docker
// manifest list (the bundle of per-service image manifests).
func (m *Manifest) IsImageIndex() bool {
	if m == nil {
		return false
	}
	return m.MediaType == MediaTypeImageIndex || m.MediaType == MediaTypeDockerManifestList
}

// ComposeLayer returns the layer descriptor whose com.docker.compose.file
// annotation equals fileName, if present.
func (m *Manifest) ComposeLayer(fileName string) *Descriptor {
	if m == nil {
		return nil
	}
	for i := range m.Layers {
		if m.Layers[i].Annotations[AnnotationComposeFile] == fileName {
			return &m.Layers[i]
		}
	}
	return nil
}

// Summary is a flat, log-friendly projection of a manifest used for structured
// observability at every receiver hop.
type Summary struct {
	MediaType     string
	ArtifactType  string
	SchemaVersion int
	ConfigDigest  string
	LayerCount    int
	ManifestCount int
	SubjectDigest string
	ComposeFiles  []string
}

// Summarize produces a log-friendly Summary of the manifest.
func (m *Manifest) Summarize() Summary {
	s := Summary{
		MediaType:     m.MediaType,
		ArtifactType:  m.ArtifactType,
		SchemaVersion: m.SchemaVersion,
		LayerCount:    len(m.Layers),
		ManifestCount: len(m.Manifests),
	}
	if m.Config != nil {
		s.ConfigDigest = m.Config.Digest
	}
	if m.Subject != nil {
		s.SubjectDigest = m.Subject.Digest
	}
	for i := range m.Layers {
		if name := m.Layers[i].Annotations[AnnotationComposeFile]; name != "" {
			s.ComposeFiles = append(s.ComposeFiles, name)
		}
	}
	return s
}

// IsDigestReference reports whether a manifest reference is a content digest
// (e.g. "sha256:...") rather than a human tag. A tag push is the terminal
// operation of `docker compose publish`, signalling the artifact is complete.
func IsDigestReference(ref string) bool {
	return strings.HasPrefix(ref, "sha256:")
}

// ServiceImage is a single per-service image entry extracted from the captured
// image index or from an individually tagged service repository. The publish
// orchestrator re-pushes these into the project namespace.
type ServiceImage struct {
	// Repository is the local receiver repository this image manifest was pushed
	// under. It is empty when the image came from a same-repo image index, in
	// which case CapturedPublish.Repository is the source repository.
	Repository  string
	Digest      string
	MediaType   string
	Size        int64
	Platform    *Platform
	ServiceName string
	RefName     string
	Annotations map[string]string
}

// CapturedPublish is the assembled result of a completed `docker compose publish`.
// It is handed to the publish orchestrator via the receiver's OnPublishComplete
// callback.
type CapturedPublish struct {
	// Repository is the OCI repository name the artifact was pushed under
	// (the host-side name in the image tag, e.g. "sam/test-one").
	Repository string

	// Reference is the tag the publish targeted (e.g. "latest").
	Reference string

	// SourceRemoteAddr is the remote address of the terminal tag-manifest push
	// that completed the compose publish.
	SourceRemoteAddr string
	// SourceIP is SourceRemoteAddr normalized to just the remote IP. The VM
	// agent uses this to bind a publish to the workspace devcontainer that
	// initiated it.
	SourceIP string

	// ProjectManifest is the top-level compose project artifact manifest.
	ProjectManifest *Manifest
	// ProjectDigest is the content digest of ProjectManifest.
	ProjectDigest string

	// ComposeYAML is the base, un-interpolated compose.yaml layer bytes.
	ComposeYAML []byte
	// ImageDigestsYAML is the digest-pinned image-digests.yaml layer bytes
	// produced by --resolve-image-digests; this is the join key between the
	// compose topology and the pushed image digests.
	ImageDigestsYAML []byte

	// ImageIndex is the OCI image index bundling the built service images, if
	// one was captured.
	ImageIndex       *Manifest
	ImageIndexDigest string

	// Services are the per-service image entries extracted from ImageIndex.
	Services []ServiceImage
}
