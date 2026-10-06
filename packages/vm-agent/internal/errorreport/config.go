package errorreport

import "time"

const (
	DefaultFlushInterval = 30 * time.Second
	DefaultMaxBatchSize  = 10
	// Match the Worker ingestion ceiling so a locally valid batch is never
	// discarded as a permanent 4xx by the receiver.
	DefaultMaxBatchBytes    = 32 * 1024
	DefaultMaxQueueSize     = 1000
	DefaultHTTPTimeout      = 10 * time.Second
	DefaultDBBusyTimeout    = 5 * time.Second
	DefaultRetryInitial     = time.Second
	DefaultRetryMax         = 5 * time.Minute
	DefaultMaxAttempts      = 20
	DefaultArtifactMaxBytes = 2 * 1024 * 1024
	DefaultSpoolMaxBytes    = 20 * 1024 * 1024
	DefaultRetention        = 24 * time.Hour
	DefaultCollectorTimeout = 10 * time.Second
	DefaultMaxCollectorDocs = 8
	DefaultMaxDocumentBytes = 128 * 1024
	DefaultMaxValueDepth    = 8
	DefaultMaxValueItems    = 256
	DefaultMaxStringBytes   = 4096
	DefaultResponseMaxBytes = 4096
	DefaultStoredErrorBytes = 512
	DefaultCollectorWorkers = 1
)

// Config holds bounded settings for durable structured errors and safe evidence.
type Config struct {
	FlushInterval    time.Duration
	MaxBatchSize     int
	MaxBatchBytes    int
	MaxQueueSize     int
	HTTPTimeout      time.Duration
	RetryInitial     time.Duration
	RetryMax         time.Duration
	MaxAttempts      int
	DBPath           string
	DBBusyTimeout    time.Duration
	SpoolDir         string
	ArtifactMaxBytes int64
	SpoolMaxBytes    int64
	Retention        time.Duration
	CollectorTimeout time.Duration
	MaxCollectorDocs int
	MaxDocumentBytes int
	MaxValueDepth    int
	MaxValueItems    int
	MaxStringBytes   int
	ResponseMaxBytes int
	StoredErrorBytes int
	CollectorWorkers int
}

func (c Config) withDefaults() Config {
	if c.FlushInterval <= 0 {
		c.FlushInterval = DefaultFlushInterval
	}
	if c.MaxBatchSize <= 0 {
		c.MaxBatchSize = DefaultMaxBatchSize
	}
	if c.MaxBatchBytes <= 0 {
		c.MaxBatchBytes = DefaultMaxBatchBytes
	}
	if c.MaxQueueSize <= 0 {
		c.MaxQueueSize = DefaultMaxQueueSize
	}
	if c.HTTPTimeout <= 0 {
		c.HTTPTimeout = DefaultHTTPTimeout
	}
	if c.DBBusyTimeout <= 0 {
		c.DBBusyTimeout = DefaultDBBusyTimeout
	}
	if c.RetryInitial <= 0 {
		c.RetryInitial = DefaultRetryInitial
	}
	if c.RetryMax <= 0 {
		c.RetryMax = DefaultRetryMax
	}
	if c.MaxAttempts <= 0 {
		c.MaxAttempts = DefaultMaxAttempts
	}
	if c.ArtifactMaxBytes <= 0 {
		c.ArtifactMaxBytes = DefaultArtifactMaxBytes
	}
	if c.SpoolMaxBytes <= 0 {
		c.SpoolMaxBytes = DefaultSpoolMaxBytes
	}
	if c.ArtifactMaxBytes > c.SpoolMaxBytes {
		c.ArtifactMaxBytes = c.SpoolMaxBytes
	}
	if c.Retention <= 0 {
		c.Retention = DefaultRetention
	}
	if c.CollectorTimeout <= 0 {
		c.CollectorTimeout = DefaultCollectorTimeout
	}
	if c.MaxCollectorDocs <= 0 {
		c.MaxCollectorDocs = DefaultMaxCollectorDocs
	}
	if c.MaxDocumentBytes <= 0 {
		c.MaxDocumentBytes = DefaultMaxDocumentBytes
	}
	if c.MaxValueDepth <= 0 {
		c.MaxValueDepth = DefaultMaxValueDepth
	}
	if c.MaxValueItems <= 0 {
		c.MaxValueItems = DefaultMaxValueItems
	}
	if c.MaxStringBytes <= 0 {
		c.MaxStringBytes = DefaultMaxStringBytes
	}
	if c.ResponseMaxBytes <= 0 {
		c.ResponseMaxBytes = DefaultResponseMaxBytes
	}
	if c.StoredErrorBytes <= 0 {
		c.StoredErrorBytes = DefaultStoredErrorBytes
	}
	if c.CollectorWorkers <= 0 {
		c.CollectorWorkers = DefaultCollectorWorkers
	}
	return c
}
