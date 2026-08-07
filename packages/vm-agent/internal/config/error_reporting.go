package config

import "time"

const (
	DefaultErrorReportMaxBatchBytes    = 32 * 1024
	DefaultErrorReportMaxAttempts      = 20
	DefaultErrorReportRetryInitial     = time.Second
	DefaultErrorReportRetryMax         = 5 * time.Minute
	DefaultErrorReportDBBusyTimeout    = 5 * time.Second
	DefaultErrorReportArtifactMaxBytes = 2 * 1024 * 1024
	DefaultErrorReportSpoolMaxBytes    = 20 * 1024 * 1024
	DefaultErrorReportRetention        = 24 * time.Hour
	DefaultErrorReportCollectorTimeout = 10 * time.Second
	DefaultErrorReportMaxCollectorDocs = 8
	DefaultErrorReportMaxDocumentBytes = 128 * 1024
	DefaultErrorReportMaxValueDepth    = 8
	DefaultErrorReportMaxValueItems    = 256
	DefaultErrorReportMaxStringBytes   = 4096
	DefaultErrorReportEventLimit       = 100
	DefaultErrorReportResponseMaxBytes = 4096
	DefaultErrorReportStoredErrorBytes = 512
	DefaultErrorReportCollectorWorkers = 1
)
