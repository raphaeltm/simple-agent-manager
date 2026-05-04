/**
 * Observability Log-Noise Regression Check
 *
 * Queries the Cloudflare API to detect two classes of observability drift:
 *
 * 1. **Repeated internal ingest errors** — e.g., 401s on the observability
 *    ingest endpoint that indicate a misconfigured tail worker or auth issue.
 *
 * 2. **Severity mismatches** — success-like messages (containing "started",
 *    "connected", "healthy", "running", "completed", etc.) persisted at
 *    error level, polluting the error dashboard with noise.
 *
 * The script queries:
 * - The Observability D1 database (persisted errors) via the CF D1 SQL API
 * - Workers telemetry (raw request logs) via the CF Workers Observability API
 *
 * Configuration (all via environment variables):
 *   CF_TOKEN              — Cloudflare API token (required)
 *   CF_ACCOUNT_ID         — Cloudflare account ID (required)
 *   OBSERVABILITY_DB_ID   — Observability D1 database ID (optional; skips D1 checks if unset)
 *   LOG_NOISE_LOOKBACK_HOURS — How far back to look (default: 24)
 *   LOG_NOISE_THRESHOLD   — Min occurrences to flag as noise (default: 10)
 *
 * Exit codes:
 *   0 — No significant noise detected
 *   1 — Noise detected (actionable findings)
 *   2 — Configuration error (missing required env vars)
 *
 * Usage:
 *   pnpm quality:observability-noise
 *   CF_ACCOUNT_ID=xxx OBSERVABILITY_DB_ID=yyy pnpm quality:observability-noise
 */

// =============================================================================
// Types
// =============================================================================

interface Finding {
  category: 'ingest-401' | 'severity-mismatch' | 'repeated-error';
  severity: 'high' | 'medium';
  message: string;
  count: number;
  sample?: string;
}

interface D1QueryResponse {
  success: boolean;
  result: Array<{
    results: Array<Record<string, unknown>>;
    meta?: { rows_read?: number };
  }>;
  errors?: Array<{ message: string }>;
}

interface TelemetryResponse {
  success: boolean;
  result?: {
    data?: Array<Record<string, unknown>>;
  };
  errors?: Array<{ message: string }>;
}

// =============================================================================
// Configuration
// =============================================================================

function getConfig() {
  const cfToken = process.env.CF_TOKEN;
  const cfAccountId = process.env.CF_ACCOUNT_ID;
  const observabilityDbId = process.env.OBSERVABILITY_DB_ID;
  const lookbackHours = parseInt(process.env.LOG_NOISE_LOOKBACK_HOURS ?? '24', 10);
  const threshold = parseInt(process.env.LOG_NOISE_THRESHOLD ?? '10', 10);

  if (!cfToken) {
    console.error('ERROR: CF_TOKEN environment variable is required');
    process.exit(2);
  }
  if (!cfAccountId) {
    console.error('ERROR: CF_ACCOUNT_ID environment variable is required');
    process.exit(2);
  }

  return { cfToken, cfAccountId, observabilityDbId, lookbackHours, threshold };
}

// =============================================================================
// CF API Helpers
// =============================================================================

async function queryD1(
  cfToken: string,
  cfAccountId: string,
  dbId: string,
  sql: string
): Promise<D1QueryResponse> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/d1/database/${dbId}/query`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sql }),
  });

  if (!resp.ok) {
    throw new Error(`D1 query failed: ${resp.status} ${resp.statusText}`);
  }

  return (await resp.json()) as D1QueryResponse;
}

async function queryWorkersTelemetry(
  cfToken: string,
  cfAccountId: string,
  sql: string
): Promise<TelemetryResponse> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${cfAccountId}/workers/observability/v1/query`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql, timeframe: 21600 }),
  });

  if (!resp.ok) {
    // Non-fatal: telemetry API may not be available in all accounts
    if (resp.status === 403 || resp.status === 404) {
      return { success: false, errors: [{ message: `Telemetry API unavailable (${resp.status})` }] };
    }
    throw new Error(`Telemetry query failed: ${resp.status} ${resp.statusText}`);
  }

  return (await resp.json()) as TelemetryResponse;
}

// =============================================================================
// Analysis Functions (exported for testing)
// =============================================================================

/**
 * Patterns that indicate a "success" or normal lifecycle message
 * that should NOT be stored at error severity.
 */
export const SUCCESS_PATTERNS = [
  'started',
  'connected',
  'healthy',
  'running',
  'completed',
  'ready',
  'initialized',
  'registered',
  'listening',
  'booted',
  'provisioned',
  'heartbeat',
];

/**
 * Build a SQL LIKE clause to detect success-like messages.
 */
export function buildSuccessPatternClause(column: string): string {
  return SUCCESS_PATTERNS.map((p) => `${column} LIKE '%${p}%'`).join(' OR ');
}

/**
 * Analyze D1 query results for repeated errors.
 */
export function analyzeRepeatedErrors(
  rows: Array<Record<string, unknown>>,
  threshold: number
): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    const count = Number(row.cnt ?? row.count ?? 0);
    const message = String(row.message ?? row.msg ?? '');
    if (count >= threshold) {
      const isIngest401 =
        message.includes('401') && message.includes('ingest');
      findings.push({
        category: isIngest401 ? 'ingest-401' : 'repeated-error',
        severity: isIngest401 ? 'high' : 'medium',
        message: message.length > 120 ? message.slice(0, 120) + '...' : message,
        count,
      });
    }
  }
  return findings;
}

/**
 * Analyze D1 query results for severity mismatches.
 */
export function analyzeSeverityMismatches(
  rows: Array<Record<string, unknown>>,
  threshold: number
): Finding[] {
  const findings: Finding[] = [];
  for (const row of rows) {
    const count = Number(row.cnt ?? row.count ?? 0);
    const message = String(row.message ?? row.msg ?? '');
    if (count >= threshold) {
      findings.push({
        category: 'severity-mismatch',
        severity: 'medium',
        message: message.length > 120 ? message.slice(0, 120) + '...' : message,
        count,
      });
    }
  }
  return findings;
}

// =============================================================================
// Report
// =============================================================================

export function formatReport(findings: Finding[]): string {
  if (findings.length === 0) {
    return '  No significant log noise detected.';
  }

  const lines: string[] = [];
  const highFindings = findings.filter((f) => f.severity === 'high');
  const mediumFindings = findings.filter((f) => f.severity === 'medium');

  if (highFindings.length > 0) {
    lines.push('  HIGH SEVERITY:');
    for (const f of highFindings) {
      lines.push(`    [${f.category}] (${f.count}x) ${f.message}`);
    }
    lines.push('');
  }

  if (mediumFindings.length > 0) {
    lines.push('  MEDIUM SEVERITY:');
    for (const f of mediumFindings) {
      lines.push(`    [${f.category}] (${f.count}x) ${f.message}`);
    }
    lines.push('');
  }

  lines.push(`  Total findings: ${findings.length}`);
  return lines.join('\n');
}

// =============================================================================
// Main
// =============================================================================

async function checkD1Noise(config: ReturnType<typeof getConfig>): Promise<Finding[]> {
  const { cfToken, cfAccountId, observabilityDbId, lookbackHours, threshold } = config;

  if (!observabilityDbId) {
    console.log('  [skip] OBSERVABILITY_DB_ID not set — skipping D1 checks');
    return [];
  }

  const sinceMs = Date.now() - lookbackHours * 60 * 60 * 1000;
  const findings: Finding[] = [];

  // Check 1: Repeated errors grouped by message
  console.log('  Querying D1 for repeated errors...');
  try {
    const repeatedSql = `SELECT message, COUNT(*) as cnt FROM platform_errors WHERE timestamp >= ${sinceMs} GROUP BY message HAVING cnt >= ${threshold} ORDER BY cnt DESC LIMIT 20`;
    const repeatedResp = await queryD1(cfToken, cfAccountId, observabilityDbId, repeatedSql);
    if (repeatedResp.success && repeatedResp.result?.[0]?.results) {
      findings.push(...analyzeRepeatedErrors(repeatedResp.result[0].results, threshold));
    }
  } catch (err) {
    console.warn(`  [warn] D1 repeated-errors query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check 2: Success-like messages at error level
  console.log('  Querying D1 for severity mismatches...');
  try {
    const successClause = buildSuccessPatternClause('message');
    const severitySql = `SELECT message, COUNT(*) as cnt FROM platform_errors WHERE timestamp >= ${sinceMs} AND level = 'error' AND (${successClause}) GROUP BY message HAVING cnt >= ${Math.max(1, Math.floor(threshold / 2))} ORDER BY cnt DESC LIMIT 20`;
    const severityResp = await queryD1(cfToken, cfAccountId, observabilityDbId, severitySql);
    if (severityResp.success && severityResp.result?.[0]?.results) {
      findings.push(...analyzeSeverityMismatches(severityResp.result[0].results, Math.max(1, Math.floor(threshold / 2))));
    }
  } catch (err) {
    console.warn(`  [warn] D1 severity-mismatch query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return findings;
}

async function checkTelemetryNoise(config: ReturnType<typeof getConfig>): Promise<Finding[]> {
  const { cfToken, cfAccountId, threshold } = config;
  const findings: Finding[] = [];

  // Check for repeated 401s on internal ingest path
  console.log('  Querying Workers telemetry for ingest 401s...');
  try {
    const telemetrySql = `SELECT COUNT(*) as cnt FROM events WHERE response.status = 401 AND $path LIKE '%/observability/logs/ingest%'`;
    const resp = await queryWorkersTelemetry(cfToken, cfAccountId, telemetrySql);

    if (!resp.success) {
      const errMsg = resp.errors?.[0]?.message ?? 'unknown error';
      console.log(`  [skip] Workers telemetry unavailable: ${errMsg}`);
      return findings;
    }

    if (resp.result?.data) {
      for (const row of resp.result.data) {
        const count = Number(row.cnt ?? 0);
        if (count >= threshold) {
          findings.push({
            category: 'ingest-401',
            severity: 'high',
            message: `401 responses on /observability/logs/ingest in telemetry window`,
            count,
          });
        }
      }
    }
  } catch (err) {
    console.warn(`  [warn] Telemetry query failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return findings;
}

async function main() {
  console.log('Observability Log-Noise Check');
  console.log('='.repeat(50));

  const config = getConfig();
  console.log(`  Lookback: ${config.lookbackHours}h | Threshold: ${config.threshold} occurrences`);
  console.log('');

  const allFindings: Finding[] = [];

  // D1 checks
  console.log('[1/2] Persisted D1 Errors');
  const d1Findings = await checkD1Noise(config);
  allFindings.push(...d1Findings);
  console.log('');

  // Telemetry checks
  console.log('[2/2] Workers Telemetry');
  const telemetryFindings = await checkTelemetryNoise(config);
  allFindings.push(...telemetryFindings);
  console.log('');

  // Report
  console.log('Results');
  console.log('-'.repeat(50));
  console.log(formatReport(allFindings));

  if (allFindings.length > 0) {
    console.log('');
    console.log('ACTION REQUIRED: Log noise detected. Review the findings above.');
    console.log('See docs/guides/deployment-troubleshooting.md#observability-noise for remediation.');
    process.exit(1);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(2);
});
