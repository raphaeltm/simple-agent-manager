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
	ErrorMessage  string      `json:"errorMessage,omitempty"`
	ComposeHash   string      `json:"composeHash,omitempty"` // SHA-256 of the rendered compose file
}

// ServiceState reports per-service container state for heartbeat reporting.
type ServiceState struct {
	Name   string `json:"name"`
	Status string `json:"status"` // running, exited, restarting, etc.
	Health string `json:"health"` // healthy, unhealthy, starting, none
}

// ObservedState is sent in the heartbeat to report deployment state.
type ObservedState struct {
	AppliedSeq   int64          `json:"appliedSeq"`
	Status       ApplyStatus    `json:"status"`
	ErrorMessage string         `json:"errorMessage,omitempty"`
	Services     []ServiceState `json:"services,omitempty"`
}

// ApplyPayload is the signed payload received from the control plane.
type ApplyPayload struct {
	EnvironmentID string        `json:"environmentId"`
	NodeID        string        `json:"nodeId"`
	Seq           int64         `json:"seq"`
	ExpiresAt     int64         `json:"expiresAt"` // Unix timestamp
	ComposeYAML   string        `json:"composeYaml"`
	Routes        []RouteTarget `json:"routes,omitempty"`
	Signature     string        `json:"signature"` // Base64-encoded Ed25519 signature

	// TODO: Registry credentials for private image pulls.
	// This field will be consumed by the apply engine to docker login
	// before pulling images. Currently stubbed pending the parallel
	// registry-credential-service work (PR in-flight).
	RegistryCredentials *RegistryCredentials `json:"registryCredentials,omitempty"`
}

// RouteTarget maps a public hostname to the loopback port published by Compose.
type RouteTarget struct {
	Hostname      string `json:"hostname"`
	Service       string `json:"service"`
	ContainerPort int    `json:"containerPort"`
	HostPort      int    `json:"hostPort"`
}

// RegistryCredentials holds credentials for pulling private container images.
// TODO: Populated by the registry-credential-service (parallel work, not yet merged).
type RegistryCredentials struct {
	Server   string `json:"server"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// SignablePayload is the canonical byte representation that gets signed.
// The signature covers: environmentId + nodeId + seq + expiresAt + sha256(composeYaml) + sha256(routes).
type SignablePayload struct {
	EnvironmentID string `json:"environmentId"`
	NodeID        string `json:"nodeId"`
	Seq           int64  `json:"seq"`
	ExpiresAt     int64  `json:"expiresAt"`
	ComposeHash   string `json:"composeHash"` // hex-encoded SHA-256 of ComposeYAML
	RoutesHash    string `json:"routesHash"`  // hex-encoded SHA-256 of canonical routes JSON
}
