package deploy

// Six-dimension status model for app deployment nodes.
// Each dimension is independently settable — a provider credential loss
// surfaces "management-degraded" without flipping app health.

// AppHealthStatus represents the health of the deployed application containers.
type AppHealthStatus string

const (
	AppHealthHealthy   AppHealthStatus = "healthy"
	AppHealthDegraded  AppHealthStatus = "degraded"  // Some services unhealthy
	AppHealthDown      AppHealthStatus = "down"       // All services down
	AppHealthUnknown   AppHealthStatus = "unknown"    // Cannot determine (no containers)
	AppHealthDeploying AppHealthStatus = "deploying"  // Apply in progress
)

// NodeHealthStatus represents the health of the underlying VM/node.
type NodeHealthStatus string

const (
	NodeHealthHealthy     NodeHealthStatus = "healthy"
	NodeHealthDegraded    NodeHealthStatus = "degraded"     // High resource usage
	NodeHealthUnreachable NodeHealthStatus = "unreachable"  // No heartbeat
	NodeHealthUnknown     NodeHealthStatus = "unknown"
)

// ProviderManageability represents whether the platform can manage the node's infrastructure.
type ProviderManageability string

const (
	ProviderManageable         ProviderManageability = "manageable"
	ProviderManagementDegraded ProviderManageability = "management-degraded" // Credential lost/expired
	ProviderManagementUnknown  ProviderManageability = "unknown"
)

// RouteCertState represents the state of public routes and TLS certificates.
type RouteCertState string

const (
	RouteCertHealthy  RouteCertState = "healthy"  // All routes serving, certs valid
	RouteCertDegraded RouteCertState = "degraded" // Some routes failing or cert expiring
	RouteCertFailed   RouteCertState = "failed"   // Routes unreachable or cert expired
	RouteCertPending  RouteCertState = "pending"  // Awaiting initial cert issuance
	RouteCertUnknown  RouteCertState = "unknown"
)

// DiskPressureLevel represents disk/volume usage pressure.
type DiskPressureLevel string

const (
	DiskPressureNone     DiskPressureLevel = "none"     // <70% usage
	DiskPressureModerate DiskPressureLevel = "moderate" // 70-85% usage
	DiskPressureHigh     DiskPressureLevel = "high"     // 85-95% usage
	DiskPressureCritical DiskPressureLevel = "critical" // >95% usage
)

// ConfigDriftState represents whether observed state matches desired state.
type ConfigDriftState string

const (
	ConfigDriftNone    ConfigDriftState = "none"    // Observed matches desired
	ConfigDriftPending ConfigDriftState = "pending" // New release not yet applied
	ConfigDriftFailed  ConfigDriftState = "failed"  // Apply failed, running stale config
	ConfigDriftUnknown ConfigDriftState = "unknown"
)

// DeploymentStatus is the six-dimension status model for a deployment node.
// Each field is independently settable.
type DeploymentStatus struct {
	AppHealth      AppHealthStatus       `json:"appHealth"`
	NodeHealth     NodeHealthStatus      `json:"nodeHealth"`
	Provider       ProviderManageability `json:"providerManageability"`
	RouteCert      RouteCertState        `json:"routeCertState"`
	DiskPressure   DiskPressureLevel     `json:"diskPressure"`
	ConfigDrift    ConfigDriftState      `json:"configDrift"`
}

// DiskTelemetry reports usage for a single filesystem/volume.
type DiskTelemetry struct {
	MountPath      string  `json:"mountPath"`
	TotalBytes     uint64  `json:"totalBytes"`
	UsedBytes      uint64  `json:"usedBytes"`
	AvailableBytes uint64  `json:"availableBytes"`
	UsedPercent    float64 `json:"usedPercent"`
}

// NodeDiskTelemetry reports usage for root disk and optional data volume.
type NodeDiskTelemetry struct {
	RootDisk   DiskTelemetry  `json:"rootDisk"`
	DataVolume *DiskTelemetry `json:"dataVolume,omitempty"`
}

// ClassifyDiskPressure returns the pressure level for a given usage percentage.
func ClassifyDiskPressure(usedPercent float64) DiskPressureLevel {
	switch {
	case usedPercent >= 95:
		return DiskPressureCritical
	case usedPercent >= 85:
		return DiskPressureHigh
	case usedPercent >= 70:
		return DiskPressureModerate
	default:
		return DiskPressureNone
	}
}

// ClassifyConfigDrift returns the drift state given observed vs desired release seq.
func ClassifyConfigDrift(observedSeq, desiredSeq int64, applyStatus ApplyStatus) ConfigDriftState {
	if desiredSeq == 0 {
		return ConfigDriftUnknown
	}
	if applyStatus == StatusFailed || applyStatus == StatusFailedInitial {
		return ConfigDriftFailed
	}
	if applyStatus == StatusApplying {
		return ConfigDriftPending
	}
	if observedSeq < desiredSeq {
		return ConfigDriftPending
	}
	return ConfigDriftNone
}

// ClassifyAppHealth derives app health from per-service container states.
func ClassifyAppHealth(services []ServiceState, applyStatus ApplyStatus) AppHealthStatus {
	if applyStatus == StatusApplying {
		return AppHealthDeploying
	}
	if len(services) == 0 {
		return AppHealthUnknown
	}

	healthyCount := 0
	for _, svc := range services {
		if svc.Status == "running" && (svc.Health == "healthy" || svc.Health == "none" || svc.Health == "") {
			healthyCount++
		}
	}

	switch {
	case healthyCount == len(services):
		return AppHealthHealthy
	case healthyCount == 0:
		return AppHealthDown
	default:
		return AppHealthDegraded
	}
}
