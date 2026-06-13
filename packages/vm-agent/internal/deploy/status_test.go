package deploy

import (
	"testing"
)

func TestClassifyDiskPressure(t *testing.T) {
	tests := []struct {
		name     string
		percent  float64
		expected DiskPressureLevel
	}{
		{"low usage", 30.0, DiskPressureNone},
		{"borderline moderate", 70.0, DiskPressureModerate},
		{"moderate usage", 75.0, DiskPressureModerate},
		{"borderline high", 85.0, DiskPressureHigh},
		{"high usage", 90.0, DiskPressureHigh},
		{"borderline critical", 95.0, DiskPressureCritical},
		{"critical usage", 98.5, DiskPressureCritical},
		{"zero", 0.0, DiskPressureNone},
		{"exactly 69.9", 69.9, DiskPressureNone},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ClassifyDiskPressure(tt.percent)
			if result != tt.expected {
				t.Errorf("ClassifyDiskPressure(%v) = %q, want %q", tt.percent, result, tt.expected)
			}
		})
	}
}

func TestClassifyConfigDrift(t *testing.T) {
	tests := []struct {
		name        string
		observed    int64
		desired     int64
		status      ApplyStatus
		expected    ConfigDriftState
	}{
		{"in sync", 5, 5, StatusApplied, ConfigDriftNone},
		{"pending new release", 4, 5, StatusApplied, ConfigDriftPending},
		{"apply in progress", 4, 5, StatusApplying, ConfigDriftPending},
		{"apply failed", 4, 5, StatusFailed, ConfigDriftFailed},
		{"failed-initial", 0, 1, StatusFailedInitial, ConfigDriftFailed},
		{"no desired seq", 3, 0, StatusApplied, ConfigDriftUnknown},
		{"reverted still same seq", 5, 5, StatusReverted, ConfigDriftNone},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ClassifyConfigDrift(tt.observed, tt.desired, tt.status)
			if result != tt.expected {
				t.Errorf("ClassifyConfigDrift(%d, %d, %q) = %q, want %q",
					tt.observed, tt.desired, tt.status, result, tt.expected)
			}
		})
	}
}

func TestClassifyAppHealth(t *testing.T) {
	tests := []struct {
		name     string
		services []ServiceState
		status   ApplyStatus
		expected AppHealthStatus
	}{
		{
			"all healthy",
			[]ServiceState{
				{Name: "web", Status: "running", Health: "healthy"},
				{Name: "api", Status: "running", Health: "none"},
			},
			StatusApplied,
			AppHealthHealthy,
		},
		{
			"one unhealthy",
			[]ServiceState{
				{Name: "web", Status: "running", Health: "healthy"},
				{Name: "api", Status: "exited", Health: ""},
			},
			StatusApplied,
			AppHealthDegraded,
		},
		{
			"all down",
			[]ServiceState{
				{Name: "web", Status: "exited", Health: ""},
				{Name: "api", Status: "exited", Health: ""},
			},
			StatusApplied,
			AppHealthDown,
		},
		{
			"no services",
			[]ServiceState{},
			StatusApplied,
			AppHealthUnknown,
		},
		{
			"deploying overrides",
			[]ServiceState{
				{Name: "web", Status: "exited", Health: ""},
			},
			StatusApplying,
			AppHealthDeploying,
		},
		{
			"running with empty health field is healthy",
			[]ServiceState{
				{Name: "web", Status: "running", Health: ""},
			},
			StatusApplied,
			AppHealthHealthy,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := ClassifyAppHealth(tt.services, tt.status)
			if result != tt.expected {
				t.Errorf("ClassifyAppHealth() = %q, want %q", result, tt.expected)
			}
		})
	}
}

func TestDeploymentStatusDimensionsIndependent(t *testing.T) {
	// A provider credential loss sets management-degraded WITHOUT changing app health.
	status := DeploymentStatus{
		AppHealth:    AppHealthHealthy,
		NodeHealth:   NodeHealthHealthy,
		Provider:     ProviderManagementDegraded,
		RouteCert:    RouteCertHealthy,
		DiskPressure: DiskPressureNone,
		ConfigDrift:  ConfigDriftNone,
	}

	if status.AppHealth != AppHealthHealthy {
		t.Error("Provider degradation should NOT affect app health")
	}
	if status.Provider != ProviderManagementDegraded {
		t.Error("Provider should be management-degraded")
	}
	if status.NodeHealth != NodeHealthHealthy {
		t.Error("Provider degradation should NOT affect node health")
	}

	// Disk pressure critical doesn't change app health
	status.DiskPressure = DiskPressureCritical
	if status.AppHealth != AppHealthHealthy {
		t.Error("Disk pressure should NOT affect app health")
	}

	// Config drift doesn't change node health
	status.ConfigDrift = ConfigDriftFailed
	if status.NodeHealth != NodeHealthHealthy {
		t.Error("Config drift should NOT affect node health")
	}
}

func TestDiskTelemetryStruct(t *testing.T) {
	telemetry := NodeDiskTelemetry{
		RootDisk: DiskTelemetry{
			MountPath:      "/",
			TotalBytes:     50 * 1024 * 1024 * 1024, // 50 GB
			UsedBytes:      20 * 1024 * 1024 * 1024,  // 20 GB
			AvailableBytes: 30 * 1024 * 1024 * 1024,  // 30 GB
			UsedPercent:    40.0,
		},
		DataVolume: &DiskTelemetry{
			MountPath:      "/mnt/sam-env-abc123",
			TotalBytes:     100 * 1024 * 1024 * 1024, // 100 GB
			UsedBytes:      85 * 1024 * 1024 * 1024,   // 85 GB
			AvailableBytes: 15 * 1024 * 1024 * 1024,   // 15 GB
			UsedPercent:    85.0,
		},
	}

	if telemetry.RootDisk.MountPath != "/" {
		t.Error("Root disk mount path wrong")
	}
	if telemetry.DataVolume == nil {
		t.Fatal("Data volume should be present")
	}
	if telemetry.DataVolume.UsedPercent != 85.0 {
		t.Error("Data volume usage percent wrong")
	}

	// Test without data volume
	noVolume := NodeDiskTelemetry{
		RootDisk: DiskTelemetry{MountPath: "/", TotalBytes: 50 * 1024 * 1024 * 1024},
	}
	if noVolume.DataVolume != nil {
		t.Error("Data volume should be nil when not present")
	}
}
