package config

const (
	// EnvDefaultPSIPollIntervalSeconds configures PSI polling cadence in seconds.
	EnvDefaultPSIPollIntervalSeconds = "DEFAULT_PSI_POLL_INTERVAL_SECONDS"
	// EnvDefaultContainerStatsIntervalSeconds configures Docker stats polling cadence in seconds.
	EnvDefaultContainerStatsIntervalSeconds = "DEFAULT_CONTAINER_STATS_INTERVAL_SECONDS"
	// EnvDefaultPSIMemorySomeWarningThreshold configures warning-level some-memory PSI.
	EnvDefaultPSIMemorySomeWarningThreshold = "DEFAULT_PSI_MEMORY_SOME_WARNING_THRESHOLD"
	// EnvDefaultPSIMemorySomeCriticalThreshold configures critical-level some-memory PSI.
	EnvDefaultPSIMemorySomeCriticalThreshold = "DEFAULT_PSI_MEMORY_SOME_CRITICAL_THRESHOLD"
	// EnvDefaultPSIMemoryFullWarningThreshold configures warning-level full-memory PSI.
	EnvDefaultPSIMemoryFullWarningThreshold = "DEFAULT_PSI_MEMORY_FULL_WARNING_THRESHOLD"
	// EnvDefaultPSIMemoryFullCriticalThreshold configures critical-level full-memory PSI.
	EnvDefaultPSIMemoryFullCriticalThreshold = "DEFAULT_PSI_MEMORY_FULL_CRITICAL_THRESHOLD"
	// EnvDefaultEvictionDebounceSeconds configures duplicate eviction debounce in seconds.
	EnvDefaultEvictionDebounceSeconds = "DEFAULT_EVICTION_DEBOUNCE_SECONDS"
	// EnvDefaultEvictionSnapshotTimeoutSeconds bounds pre-stop eviction snapshots in seconds.
	EnvDefaultEvictionSnapshotTimeoutSeconds = "DEFAULT_EVICTION_SNAPSHOT_TIMEOUT_SECONDS"
	// EnvDefaultEvictionDockerStopTimeoutSeconds bounds graceful docker stop in seconds.
	EnvDefaultEvictionDockerStopTimeoutSeconds = "DEFAULT_EVICTION_DOCKER_STOP_TIMEOUT_SECONDS"
	// EnvDefaultEvictionResolveTimeoutSeconds bounds Docker label resolution before eviction.
	EnvDefaultEvictionResolveTimeoutSeconds = "DEFAULT_EVICTION_RESOLVE_TIMEOUT_SECONDS"
)

const (
	// DefaultPSIPollIntervalSeconds is the default PSI polling cadence.
	DefaultPSIPollIntervalSeconds = 10
	// DefaultContainerStatsIntervalSeconds is the default Docker stats polling cadence.
	DefaultContainerStatsIntervalSeconds = 30
	// DefaultPSIMemorySomeWarningThreshold is the default warning threshold for some-memory PSI.
	DefaultPSIMemorySomeWarningThreshold = 25.0
	// DefaultPSIMemorySomeCriticalThreshold is the default critical threshold for some-memory PSI.
	DefaultPSIMemorySomeCriticalThreshold = 50.0
	// DefaultPSIMemoryFullWarningThreshold is the default warning threshold for full-memory PSI.
	DefaultPSIMemoryFullWarningThreshold = 10.0
	// DefaultPSIMemoryFullCriticalThreshold is the default critical threshold for full-memory PSI.
	DefaultPSIMemoryFullCriticalThreshold = 25.0
	// DefaultEvictionDebounceSeconds is the default duplicate eviction debounce window.
	DefaultEvictionDebounceSeconds = 30
	// DefaultEvictionSnapshotTimeoutSeconds is the default pre-stop snapshot deadline.
	DefaultEvictionSnapshotTimeoutSeconds = 120
	// DefaultEvictionDockerStopTimeoutSeconds is the default graceful docker stop deadline.
	DefaultEvictionDockerStopTimeoutSeconds = 10
	// DefaultEvictionResolveTimeoutSeconds is the default pressure target resolution deadline.
	DefaultEvictionResolveTimeoutSeconds = 5
)
