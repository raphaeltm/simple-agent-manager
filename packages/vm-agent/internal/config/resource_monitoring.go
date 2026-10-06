package config

const (
	// EnvDefaultResourceEventBufferSize configures each bounded pressure event queue.
	EnvDefaultResourceEventBufferSize = "DEFAULT_RESOURCE_EVENT_BUFFER_SIZE"
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
	// EnvDefaultEvictionCallbackRetryMaxSeconds caps durable callback retry backoff.
	EnvDefaultEvictionCallbackRetryMaxSeconds = "DEFAULT_EVICTION_CALLBACK_RETRY_MAX_SECONDS"
	// EnvDefaultEvictionResolveTimeoutSeconds bounds Docker label resolution before eviction.
	EnvDefaultEvictionResolveTimeoutSeconds = "DEFAULT_EVICTION_RESOLVE_TIMEOUT_SECONDS"
	// EnvResourceHistorySampleInterval configures retained resource telemetry sampling cadence.
	EnvResourceHistorySampleInterval = "RESOURCE_HISTORY_SAMPLE_INTERVAL"
	// EnvResourceHistoryChunkInterval configures retained resource telemetry chunk duration.
	EnvResourceHistoryChunkInterval = "RESOURCE_HISTORY_CHUNK_INTERVAL"
	// EnvResourceHistorySpoolDir configures the node-local retry spool directory.
	EnvResourceHistorySpoolDir = "RESOURCE_HISTORY_SPOOL_DIR"
	// EnvResourceHistorySpoolMaxBytes configures the maximum local retry spool size.
	EnvResourceHistorySpoolMaxBytes = "RESOURCE_HISTORY_SPOOL_MAX_BYTES"
	// EnvResourceHistoryUploadTimeout configures each telemetry upload request deadline.
	EnvResourceHistoryUploadTimeout = "RESOURCE_HISTORY_UPLOAD_TIMEOUT"
	// EnvResourceHistoryMaxSamples configures maximum samples per uploaded chunk.
	EnvResourceHistoryMaxSamples = "RESOURCE_HISTORY_MAX_SAMPLES"
)

const (
	// DefaultResourceEventBufferSize is the capacity of each pressure event queue.
	DefaultResourceEventBufferSize = 64
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
	// DefaultEvictionCallbackRetryMaxSeconds is the maximum callback retry backoff.
	DefaultEvictionCallbackRetryMaxSeconds = 300
	// DefaultEvictionResolveTimeoutSeconds is the default pressure target resolution deadline.
	DefaultEvictionResolveTimeoutSeconds = 5
	// DefaultResourceHistorySpoolMaxBytes is the bounded telemetry retry spool size.
	DefaultResourceHistorySpoolMaxBytes int64 = 20 * 1024 * 1024
	// DefaultResourceHistoryMaxSamples bounds one telemetry chunk.
	DefaultResourceHistoryMaxSamples = 4096
	// MaxResourceHistoryMaxSamples is the operator-tunable ceiling for one telemetry chunk.
	MaxResourceHistoryMaxSamples = 32768
)

// IsValidPSIThreshold accepts finite stall percentages in (0, 100].
// Positive comparisons deliberately reject NaN as well as infinities.
func IsValidPSIThreshold(value float64) bool { return value > 0 && value <= 100 }
