/**
 * The one Cloudflare GraphQL analytics request behind every cost estimate, and its parser.
 * Account-scoped: it covers everything billed to the Cloudflare account, not one Worker.
 *
 * Cloudflare refuses a query whose date range is wider than 4w4d, or whose start is older than
 * 4w4d ("quota" error, observed 2026-11-16), so one request covers at most ~31 complete days and
 * older days cannot be fetched at all. `/accounts/:id/billable/usage` is not used (rule 76.6).
 */
import type { CloudflareCostRows } from './types';

export const CLOUDFLARE_GRAPHQL_ENDPOINT = 'https://api.cloudflare.com/client/v4/graphql';
/** Days one request may span and reach back (Cloudflare's 4w4d limit, minus a day of margin). */
export const CLOUDFLARE_ANALYTICS_MAX_DAYS = 31;

export interface CloudflareCostQueryOptions {
  /**
   * Also group Durable Object periodic rows by namespace and object name, for the CLI's
   * namespace breakdown. Adds a row per object per day, so the stored snapshot leaves it off.
   */
  durableObjectBreakdown?: boolean;
}

export function buildCloudflareCostQuery(options: CloudflareCostQueryOptions = {}): string {
  const doDims = options.durableObjectBreakdown ? 'date namespaceId name' : 'date';
  const doOrder = options.durableObjectBreakdown
    ? '[date_ASC, namespaceId_ASC, name_ASC]'
    : '[date_ASC]';
  const range = 'filter: { date_geq: $start, date_leq: $end }, limit: $limit';
  return `
query CloudflareCostAudit($accountTag: string!, $start: Date!, $end: Date!, $limit: uint64!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      durableObjectsPeriodicGroups(${range}, orderBy: ${doOrder}) {
        dimensions { ${doDims} }
        sum { activeTime duration rowsRead rowsWritten storageReadUnits storageWriteUnits }
      }
      durableObjectsInvocationsAdaptiveGroups(${range}, orderBy: [date_ASC]) {
        dimensions { date }
        sum { requests }
      }
      workersInvocationsAdaptive(${range}, orderBy: [date_ASC, eventType_ASC]) {
        dimensions { date eventType }
        sum { requests cpuTimeUs }
      }
      kvOperationsAdaptiveGroups(${range}, orderBy: [date_ASC, actionType_ASC]) {
        dimensions { date actionType }
        sum { requests }
      }
      kvStorageAdaptiveGroups(${range}, orderBy: [date_ASC, namespaceId_ASC]) {
        dimensions { date namespaceId }
        max { byteCount }
      }
      aiInferenceAdaptiveGroups(${range}, orderBy: [date_ASC]) {
        dimensions { date }
        sum { totalNeurons }
      }
      r2StorageAdaptiveGroups(${range}, orderBy: [date_ASC, bucketName_ASC, storageClass_ASC]) {
        dimensions { date bucketName storageClass }
        max { metadataSize payloadSize }
      }
      d1AnalyticsAdaptiveGroups(${range}, orderBy: [date_ASC]) {
        dimensions { date }
        sum { rowsRead rowsWritten }
      }
      d1StorageAdaptiveGroups(${range}, orderBy: [date_ASC, databaseId_ASC]) {
        dimensions { date databaseId }
        max { databaseSizeBytes }
      }
      containersUsageAdaptiveGroups(${range}, orderBy: [date_ASC]) {
        dimensions { date }
        sum { allocatedMemory }
      }
    }
  }
}`;
}

export function cloudflareCostQueryBody(input: {
  accountId: string;
  startDate: string;
  endDate: string;
  limit: number;
  options?: CloudflareCostQueryOptions;
}): string {
  return JSON.stringify({
    query: buildCloudflareCostQuery(input.options),
    variables: {
      accountTag: input.accountId,
      start: input.startDate,
      end: input.endDate,
      limit: input.limit,
    },
  });
}

/**
 * Why a request failed, by what the operator must do (`.claude/rules/72`):
 * - `permission`: the token is invalid or lacks Account Analytics: Read; fix the token.
 * - `range`: the dates are outside what Cloudflare serves; fix the window.
 * - `truncated`: a dataset reached the row limit; raise the limit.
 * - `failed`: anything else (outage, malformed response); retry later.
 */
export type CloudflareCostErrorKind = 'permission' | 'range' | 'truncated' | 'failed';

export class CloudflareCostQueryError extends Error {
  constructor(
    readonly kind: CloudflareCostErrorKind,
    message: string
  ) {
    super(message);
    this.name = 'CloudflareCostQueryError';
  }
}

interface GraphQLError {
  message?: unknown;
  code?: unknown;
  extensions?: { code?: unknown } | null;
}

type AccountPayload = Partial<{
  durableObjectsPeriodicGroups: CloudflareCostRows['durableObjectPeriodic'];
  durableObjectsInvocationsAdaptiveGroups: CloudflareCostRows['durableObjectInvocations'];
  workersInvocationsAdaptive: CloudflareCostRows['workersInvocations'];
  kvOperationsAdaptiveGroups: CloudflareCostRows['kvOperations'];
  kvStorageAdaptiveGroups: CloudflareCostRows['kvStorage'];
  aiInferenceAdaptiveGroups: CloudflareCostRows['workersAi'];
  r2StorageAdaptiveGroups: CloudflareCostRows['r2Storage'];
  d1AnalyticsAdaptiveGroups: CloudflareCostRows['d1Analytics'];
  d1StorageAdaptiveGroups: CloudflareCostRows['d1Storage'];
  containersUsageAdaptiveGroups: CloudflareCostRows['containers'];
}>;

const PERMISSION_PATTERN = /authenticat|not authori[sz]ed|unauthori[sz]ed|permission|forbidden/i;

/** Classifies a non-2xx HTTP status from the GraphQL endpoint. */
export function cloudflareCostHttpError(status: number): CloudflareCostQueryError {
  return new CloudflareCostQueryError(
    status === 401 || status === 403 ? 'permission' : 'failed',
    `Cloudflare GraphQL request failed with HTTP ${status}`
  );
}

function classifyErrors(errors: GraphQLError[]): CloudflareCostQueryError {
  const messages = errors.map((error) => String(error.message ?? 'unknown error'));
  const codes = errors.map((error) => String(error.extensions?.code ?? error.code ?? ''));
  const text = messages.join('; ').slice(0, 500);
  if (codes.includes('10000') || messages.some((m) => PERMISSION_PATTERN.test(m)))
    return new CloudflareCostQueryError('permission', `Cloudflare GraphQL error: ${text}`);
  if (codes.includes('quota'))
    return new CloudflareCostQueryError('range', `Cloudflare GraphQL error: ${text}`);
  return new CloudflareCostQueryError('failed', `Cloudflare GraphQL error: ${text}`);
}

/**
 * Rows of every dataset. Refuses a partial answer: an error, a missing account, or a dataset
 * that reached `limit` (more rows may exist) throws rather than under-reporting cost.
 */
export function parseCloudflareCostResponse(payload: unknown, limit: number): CloudflareCostRows {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload))
    throw new CloudflareCostQueryError('failed', 'Cloudflare GraphQL response must be an object');
  const response = payload as {
    data?: { viewer?: { accounts?: AccountPayload[] | null } | null } | null;
    errors?: GraphQLError[] | null;
  };
  if (Array.isArray(response.errors) && response.errors.length > 0)
    throw classifyErrors(response.errors);
  const account = response.data?.viewer?.accounts?.[0];
  if (!account)
    throw new CloudflareCostQueryError(
      'permission',
      'Cloudflare GraphQL response did not include the requested account'
    );
  const rows: CloudflareCostRows = {
    durableObjectPeriodic: arrayOf(account.durableObjectsPeriodicGroups),
    durableObjectInvocations: arrayOf(account.durableObjectsInvocationsAdaptiveGroups),
    workersInvocations: arrayOf(account.workersInvocationsAdaptive),
    kvOperations: arrayOf(account.kvOperationsAdaptiveGroups),
    kvStorage: arrayOf(account.kvStorageAdaptiveGroups),
    workersAi: arrayOf(account.aiInferenceAdaptiveGroups),
    r2Storage: arrayOf(account.r2StorageAdaptiveGroups),
    d1Analytics: arrayOf(account.d1AnalyticsAdaptiveGroups),
    d1Storage: arrayOf(account.d1StorageAdaptiveGroups),
    containers: arrayOf(account.containersUsageAdaptiveGroups),
  };
  for (const [name, dataset] of Object.entries(rows)) {
    if ((dataset as unknown[]).length >= limit) {
      throw new CloudflareCostQueryError(
        'truncated',
        `${name} returned ${(dataset as unknown[]).length} rows, which reached the query limit ${limit}; refusing a partial cost estimate`
      );
    }
  }
  return rows;
}

function arrayOf<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}
