// Package deploy implements the restart-safe deployment engine for SAM app deployment nodes.
// It manages desired state on disk, applies Docker Compose changes idempotently,
// and reports observed state back to the control plane via heartbeat.
package deploy

import "time"

// ApplyStatus represents the state of a release application.
type ApplyStatus string

const (
	StatusApplied       ApplyStatus = "applied"
	StatusApplying      ApplyStatus = "applying"
	StatusFailed        ApplyStatus = "failed"
	StatusReverted      ApplyStatus = "reverted"
	StatusFailedInitial ApplyStatus = "failed-initial"
)

// ReleaseState represents a release's persisted metadata on disk.
type ReleaseState struct {
	Seq           int64       `json:"seq"`
	EnvironmentID string      `json:"environmentId"`
	NodeID        string      `json:"nodeId"`
	Status        ApplyStatus `json:"status"`
	AppliedAt     time.Time   `json:"appliedAt,omitempty"`
	FailedAt      time.Time   `json:"failedAt,omitempty"`
	ErrorMessage   string      `json:"errorMessage,omitempty"`
	RoutingRevision int64       `json:"routingRevision,omitempty"`
	RoutingStatus   string      `json:"routingStatus,omitempty"`
	RoutingError    string      `json:"routingError,omitempty"`
	ComposeHash     string      `json:"composeHash,omitempty"` // SHA-256 of the rendered compose file
	// Host mount roots created for this release's provider-backed volumes.
	// Persisted so teardown/rollback can unmount even if Compose parsing fails.
	VolumeMountRoots []string `json:"volumeMountRoots,omitempty"`
}

// ServiceState reports per-service container state for heartbeat reporting.
type ServiceState struct {
	Name    string `json:"name"`
	Service string `json:"service,omitempty"`
	Status  string `json:"status"` // running, exited, restarting, etc.
	Health  string `json:"health"` // healthy, unhealthy, starting, none
}

// ObservedState is sent in the heartbeat to report deployment state.
type ObservedState struct {
	AppliedSeq      int64          `json:"appliedSeq"`
	Status          ApplyStatus    `json:"status"`
	ErrorMessage    string         `json:"errorMessage,omitempty"`
	RoutingRevision int64          `json:"routingRevision,omitempty"`
	RoutingStatus   string         `json:"routingStatus,omitempty"`
	RoutingError    string         `json:"routingError,omitempty"`
	Services        []ServiceState `json:"services,omitempty"`

	// Day-2 status model: six independent dimensions
	DeployStatus *DeploymentStatus `json:"deployStatus,omitempty"`
	// Disk telemetry for root disk and optional data volume
	DiskTelemetry *NodeDiskTelemetry `json:"diskTelemetry,omitempty"`
}

// ApplyPayload is the signed payload received from the control plane.
type ApplyPayload struct {
	EnvironmentID    string            `json:"environmentId"`
	NodeID           string            `json:"nodeId"`
	Seq              int64             `json:"seq"`
	ExpiresAt        int64             `json:"expiresAt"` // Unix timestamp
	ComposeYAML      string            `json:"composeYaml"`
	InterpolationEnv map[string]string `json:"interpolationEnv,omitempty"`
	Routes           []RouteTarget     `json:"routes,omitempty"`
	Artifacts        []ImageArtifact   `json:"artifacts,omitempty"`
	VolumeMounts     []VolumeMount     `json:"volumeMounts,omitempty"`
	Signature        string            `json:"signature"` // Base64-encoded Ed25519 signature

	// Registry credentials for private image pulls. When present, the
	// deploy engine calls docker login --password-stdin before composePull.
	RegistryCredentials *RegistryCredentials `json:"registryCredentials,omitempty"`
}

type RouteConfigPayload struct {
	EnvironmentID   string        `json:"environmentId"`
	NodeID          string        `json:"nodeId"`
	CurrentSeq      int64         `json:"currentSeq"`
	RoutingRevision int64         `json:"routingRevision"`
	ExpiresAt       int64         `json:"expiresAt"`
	Routes          []RouteTarget `json:"routes,omitempty"`
	Signature       string        `json:"signature"`
}

type DeploymentEnvResponse struct {
	EnvironmentID    string            `json:"environmentId"`
	InterpolationEnv map[string]string `json:"interpolationEnv,omitempty"`
	ConfigUpdatedAt  string            `json:"configUpdatedAt,omitempty"`
}

// RouteTarget maps a public hostname to the loopback port published by Compose.
type RouteTarget struct {
	Hostname      string `json:"hostname"`
	Service       string `json:"service"`
	ContainerPort int    `json:"containerPort"`
	HostPort      int    `json:"hostPort"`
}

// ImageArtifact describes a signed R2-backed docker-save archive to load before
// running Compose. DownloadURL is short-lived; the key, hash, size, and target
// local ref are covered by the deploy payload signature.
type ImageArtifact struct {
	ServiceName       string    `json:"serviceName"`
	SourceRef         string    `json:"sourceRef"`
	LocalImageRef     string    `json:"localImageRef"`
	R2Key             string    `json:"r2Key"`
	SizeBytes         int64     `json:"sizeBytes"`
	ArchiveSHA256     string    `json:"archiveSha256"`
	ArchiveType       string    `json:"archiveType"`
	MediaType         string    `json:"mediaType"`
	Platform          *Platform `json:"platform,omitempty"`
	DownloadURL       string    `json:"downloadUrl"`
	DownloadExpiresIn int64     `json:"downloadExpiresIn"`
}

type Platform struct {
	Architecture string `json:"architecture,omitempty"`
	OS           string `json:"os,omitempty"`
	Variant      string `json:"variant,omitempty"`
}

type VolumeMount struct {
	Name             string `json:"name"`
	MountRoot        string `json:"mountRoot"`
	ProviderVolumeID string `json:"providerVolumeId"`
	ProviderName     string `json:"providerName"`
	LinuxDevice      string `json:"linuxDevice,omitempty"`
	FSFormat         string `json:"fsFormat"`
}

// RegistryCredentials holds credentials for pulling private container images.
// Populated by the deploy-release callback when CF registry minting is available.
type RegistryCredentials struct {
	Server   string `json:"server"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// SignablePayload is the canonical byte representation that gets signed.
// The signature covers: environmentId + nodeId + seq + expiresAt + sha256(composeYaml) + sha256(routes) + sha256(interpolationEnv) + sha256(artifacts).
type SignablePayload struct {
	EnvironmentID        string `json:"environmentId"`
	NodeID               string `json:"nodeId"`
	Seq                  int64  `json:"seq"`
	ExpiresAt            int64  `json:"expiresAt"`
	ComposeHash          string `json:"composeHash"` // hex-encoded SHA-256 of ComposeYAML
	RoutesHash           string `json:"routesHash"`  // hex-encoded SHA-256 of canonical routes JSON
	InterpolationEnvHash string `json:"interpolationEnvHash"`
	ArtifactsHash        string `json:"artifactsHash"`
	VolumeMountsHash     string `json:"volumeMountsHash"`
}

type SignableRouteConfigPayload struct {
	EnvironmentID   string `json:"environmentId"`
	NodeID          string `json:"nodeId"`
	CurrentSeq      int64  `json:"currentSeq"`
	RoutingRevision int64  `json:"routingRevision"`
	ExpiresAt       int64  `json:"expiresAt"`
	RoutesHash      string `json:"routesHash"`
}
