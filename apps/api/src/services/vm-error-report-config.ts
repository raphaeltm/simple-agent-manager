import type { CloudInitVariables } from '@simple-agent-manager/cloud-init';

import type { Env } from '../env';

type ErrorReportCloudInitVariables = Pick<
  CloudInitVariables,
  Extract<keyof CloudInitVariables, `errorReport${string}`>
>;

/**
 * VM agent durable error-reporter tunables relayed into cloud-init. An unset var stays
 * undefined so `generateCloudInit` (`packages/cloud-init/src/generate.ts`) applies its own
 * default, which is why these vars are not shipped in `apps/api/wrangler.toml [vars]`.
 */
export function errorReportCloudInitVariables(env: Env): ErrorReportCloudInitVariables {
  return {
    errorReportFlushInterval: env.ERROR_REPORT_FLUSH_INTERVAL,
    errorReportMaxBatchSize: env.ERROR_REPORT_MAX_BATCH_SIZE,
    errorReportMaxBatchBytes: env.ERROR_REPORT_MAX_BATCH_BYTES,
    errorReportMaxQueueSize: env.ERROR_REPORT_MAX_QUEUE_SIZE,
    errorReportHttpTimeout: env.ERROR_REPORT_HTTP_TIMEOUT,
    errorReportRetryInitial: env.ERROR_REPORT_RETRY_INITIAL,
    errorReportRetryMax: env.ERROR_REPORT_RETRY_MAX,
    errorReportMaxAttempts: env.ERROR_REPORT_MAX_ATTEMPTS,
    errorReportDbPath: env.ERROR_REPORT_DB_PATH,
    errorReportDbBusyTimeout: env.ERROR_REPORT_DB_BUSY_TIMEOUT,
    errorReportSpoolDir: env.ERROR_REPORT_SPOOL_DIR,
    errorReportArtifactMaxBytes: env.ERROR_REPORT_ARTIFACT_MAX_BYTES,
    errorReportSpoolMaxBytes: env.ERROR_REPORT_SPOOL_MAX_BYTES,
    errorReportRetention: env.ERROR_REPORT_RETENTION,
    errorReportCollectorTimeout: env.ERROR_REPORT_COLLECTOR_TIMEOUT,
    errorReportMaxCollectorDocs: env.ERROR_REPORT_MAX_COLLECTOR_DOCS,
    errorReportMaxDocumentBytes: env.ERROR_REPORT_MAX_DOCUMENT_BYTES,
    errorReportMaxValueDepth: env.ERROR_REPORT_MAX_VALUE_DEPTH,
    errorReportMaxValueItems: env.ERROR_REPORT_MAX_VALUE_ITEMS,
    errorReportMaxStringBytes: env.ERROR_REPORT_MAX_STRING_BYTES,
    errorReportEventLimit: env.ERROR_REPORT_EVENT_LIMIT,
    errorReportResponseMaxBytes: env.ERROR_REPORT_RESPONSE_MAX_BYTES,
    errorReportStoredErrorMaxBytes: env.ERROR_REPORT_STORED_ERROR_MAX_BYTES,
    errorReportCollectorConcurrency: env.ERROR_REPORT_COLLECTOR_CONCURRENCY,
  };
}
