package config

import (
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

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

const (
	// EnvEvictionFinalSnapshotTimeoutSeconds bounds the post-stop quiesced eviction capture.
	EnvEvictionFinalSnapshotTimeoutSeconds = "EVICTION_FINAL_SNAPSHOT_TIMEOUT_SECONDS"
	// EnvSnapshotHelperMemoryLimit is the docker --memory value for a snapshot helper container.
	EnvSnapshotHelperMemoryLimit = "SNAPSHOT_HELPER_MEMORY_LIMIT"
	// EnvSnapshotHelperPidsLimit is the docker --pids-limit value for a snapshot helper container.
	EnvSnapshotHelperPidsLimit = "SNAPSHOT_HELPER_PIDS_LIMIT"
	// EnvSnapshotHelperMinFreeBytes is the disk headroom kept free beyond the committed layer.
	EnvSnapshotHelperMinFreeBytes = "SNAPSHOT_HELPER_MIN_FREE_BYTES"

	// DefaultEvictionFinalSnapshotTimeoutSeconds allows a multi-GiB writable layer to commit
	// (~100-300 MB/s) plus a full HOME/WIP capture and upload, while bounding how long a
	// relocation waits for it. A timeout keeps the live capture and grants no preservation.
	DefaultEvictionFinalSnapshotTimeoutSeconds = 300
	// DefaultSnapshotHelperMemoryLimit bounds git/tar inside the helper.
	DefaultSnapshotHelperMemoryLimit = "1g"
	// DefaultSnapshotHelperPidsLimit bounds processes inside the helper.
	DefaultSnapshotHelperPidsLimit = 256
	// DefaultSnapshotHelperMinFreeBytes keeps 1 GiB free after committing the writable layer.
	DefaultSnapshotHelperMinFreeBytes int64 = 1 << 30
)

// SnapshotHelperConfig bounds the temporary container that captures a stopped workspace.
type SnapshotHelperConfig struct {
	FinalSnapshotTimeout time.Duration
	MemoryLimit          string
	PidsLimit            int
	MinFreeBytes         int64
}

func loadSnapshotHelperConfig() SnapshotHelperConfig {
	return SnapshotHelperConfig{
		FinalSnapshotTimeout: time.Duration(getEnvInt(EnvEvictionFinalSnapshotTimeoutSeconds, DefaultEvictionFinalSnapshotTimeoutSeconds)) * time.Second,
		MemoryLimit:          strings.TrimSpace(getEnv(EnvSnapshotHelperMemoryLimit, DefaultSnapshotHelperMemoryLimit)),
		PidsLimit:            getEnvInt(EnvSnapshotHelperPidsLimit, DefaultSnapshotHelperPidsLimit),
		MinFreeBytes:         getEnvInt64(EnvSnapshotHelperMinFreeBytes, DefaultSnapshotHelperMinFreeBytes),
	}
}

// WithDefaults fills unset fields, so a Config built without loadSnapshotHelperConfig
// (tests, older call sites) still gets bounded helpers.
func (c SnapshotHelperConfig) WithDefaults() SnapshotHelperConfig {
	if c.FinalSnapshotTimeout <= 0 {
		c.FinalSnapshotTimeout = DefaultEvictionFinalSnapshotTimeoutSeconds * time.Second
	}
	if c.MemoryLimit == "" {
		c.MemoryLimit = DefaultSnapshotHelperMemoryLimit
	}
	if c.PidsLimit <= 0 {
		c.PidsLimit = DefaultSnapshotHelperPidsLimit
	}
	if c.MinFreeBytes <= 0 {
		c.MinFreeBytes = DefaultSnapshotHelperMinFreeBytes
	}
	return c
}

// validate rejects explicitly invalid operator values. Zero means "not supplied" for every
// field and resolves through WithDefaults.
func (c SnapshotHelperConfig) validate() []error {
	var errs []error
	if c.FinalSnapshotTimeout < 0 {
		errs = append(errs, fmt.Errorf("%s must be >= 0 (0 uses the default), got %s", EnvEvictionFinalSnapshotTimeoutSeconds, c.FinalSnapshotTimeout))
	}
	// An empty value resolves to the default, but a value that parses to zero bytes would
	// reach `docker create --memory` as 0, which Docker treats as unlimited.
	if c.MemoryLimit != "" {
		if bytes, ok := dockerMemoryBytes(c.MemoryLimit); !ok || bytes <= 0 {
			errs = append(errs, fmt.Errorf("%s must be a positive Docker memory size such as 1g, got %q", EnvSnapshotHelperMemoryLimit, c.MemoryLimit))
		}
	}
	if c.PidsLimit < 0 {
		errs = append(errs, fmt.Errorf("%s must be >= 0 (0 uses the default), got %d", EnvSnapshotHelperPidsLimit, c.PidsLimit))
	}
	if c.MinFreeBytes < 0 {
		errs = append(errs, fmt.Errorf("%s must be >= 0, got %d", EnvSnapshotHelperMinFreeBytes, c.MinFreeBytes))
	}
	return errs
}

// dockerMemorySize is the grammar Docker's --memory flag accepts (go-units RAMInBytes).
var dockerMemorySize = regexp.MustCompile(`^(\d+(\.\d+)*) ?([kKmMgGtTpP])?[iI]?[bB]?$`)

// dockerMemoryBytes parses a --memory value the way Docker does, with binary multipliers.
func dockerMemoryBytes(value string) (int64, bool) {
	match := dockerMemorySize.FindStringSubmatch(value)
	if match == nil {
		return 0, false
	}
	size, err := strconv.ParseFloat(match[1], 64)
	if err != nil {
		return 0, false
	}
	if unit := strings.ToLower(match[3]); unit != "" {
		size *= float64(int64(1) << (10 * (strings.Index("kmgtp", unit) + 1)))
	}
	if size >= math.MaxInt64 {
		return 0, false
	}
	return int64(size), true
}
