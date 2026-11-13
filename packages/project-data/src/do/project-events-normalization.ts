import {
  type AdmitProjectEventInput,
  CREDENTIAL_LIMIT_EVENT_SOURCE,
  PROJECT_EVENT_FILTER_FIELDS,
  PROJECT_EVENT_FILTER_VERSION,
  PROJECT_EVENT_SEVERITIES,
  type ProjectEventAudience,
  type ProjectEventDisplayData,
  type ProjectEventFilterField,
  type ProjectEventFilterV1,
  type ProjectEventLimits,
  type ProjectEventMetadata,
  type ProjectEventRawPayloadRef,
  type ProjectEventRecord,
  type ProjectEventSeverity,
} from '@simple-agent-manager/shared';

import {
  ProjectEventLimitExceededError,
  ProjectEventValidationError,
} from './project-events-contracts';
import {
  byteLength,
  isPlainObject,
  normalizeJsonValue,
  normalizeNullableText,
  normalizeOptionalText,
  normalizeStringSet,
  normalizeText,
  normalizeTimestamp,
  sortJson,
  stableStringify,
} from './project-events-values';

export type CompiledProjectEventFilter = {
  filter: ProjectEventFilterV1;
  fingerprint: string;
  matchKeys: ProjectEventMatchKey[];
};

export type ProjectEventMatchKey = {
  field: ProjectEventFilterField;
  value: string;
  matchKey: string;
};

export type NormalizedProjectEventInput = Omit<
  ProjectEventRecord,
  'id' | 'state' | 'duplicateCount' | 'conflictCount' | 'conflictFingerprint' | 'conflictDetectedAt'
> & {
  metadataJson: string;
  metadataBytes: number;
  displayJson: string;
  displayBytes: number;
  rawPayloadRefJson: string | null;
  rawPayloadRefBytes: number;
};

const FILTER_FIELD_SET = new Set<string>(PROJECT_EVENT_FILTER_FIELDS);
const SEVERITY_SET = new Set<string>(PROJECT_EVENT_SEVERITIES);

export function normalizeProjectId(projectId: string, limits: ProjectEventLimits): string {
  return normalizeText(projectId, 'projectId', limits.maxFilterStringBytes);
}

export function assertProjectBinding(storedProjectId: string | null, inputProjectId: string): void {
  if (!storedProjectId)
    throw new ProjectEventValidationError('ProjectData project binding is missing');
  if (storedProjectId !== inputProjectId) {
    throw new ProjectEventValidationError('ProjectData project binding mismatch');
  }
}

export function normalizeListLimit(
  limit: number | null | undefined,
  limits: ProjectEventLimits
): number {
  if (limit === null || limit === undefined) return limits.listLimitDefault;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ProjectEventValidationError('limit must be a positive integer');
  }
  return Math.min(limit, limits.listLimitMax);
}

export function normalizeProjectEventInput(
  input: AdmitProjectEventInput,
  limits: ProjectEventLimits
): NormalizedProjectEventInput {
  const now = Date.now();
  const projectId = normalizeProjectId(input.projectId, limits);
  const source = normalizeText(input.source, 'source', limits.maxFilterStringBytes);
  const eventType = normalizeText(input.eventType, 'eventType', limits.maxFilterStringBytes);
  const subject = {
    type: normalizeText(input.subject?.type, 'subject.type', limits.maxFilterStringBytes),
    id: normalizeText(input.subject?.id, 'subject.id', limits.maxFilterStringBytes),
  };
  const severity = normalizeSeverity(input.severity ?? 'info');
  const deliveryKey = normalizeText(input.deliveryKey, 'deliveryKey', limits.maxFilterStringBytes);
  const payloadFingerprint = normalizeText(
    input.payloadFingerprint,
    'payloadFingerprint',
    limits.maxFilterStringBytes
  );
  const { metadata, metadataJson, metadataBytes } = normalizeMetadataWithinBudget(
    input.metadata ?? {},
    limits
  );
  const audience = deriveProjectEventAudience(projectId, source, metadata);
  const display = normalizeDisplay(input.display, limits);
  const displayJson = stableStringify(display);
  const displayBytes = byteLength(displayJson);
  if (displayBytes > limits.maxDisplayBytes) {
    throw new ProjectEventLimitExceededError(
      `display data must be ${limits.maxDisplayBytes} bytes or fewer`
    );
  }
  const rawPayloadRef = normalizeRawPayloadRef(input.rawPayloadRef ?? null, limits);
  const rawPayloadRefJson = rawPayloadRef ? stableStringify(rawPayloadRef) : null;
  const rawPayloadRefBytes = rawPayloadRefJson ? byteLength(rawPayloadRefJson) : 0;
  const occurredAt = normalizeTimestamp(input.occurredAt ?? input.receivedAt ?? now, 'occurredAt');
  const receivedAt = Math.min(normalizeTimestamp(input.receivedAt ?? now, 'receivedAt'), now);

  return {
    projectId,
    contractVersion: 1,
    source,
    eventType,
    subject,
    severity,
    deliveryKey,
    payloadFingerprint,
    metadata,
    audience,
    display,
    rawPayloadRef,
    occurredAt,
    receivedAt,
    updatedAt: receivedAt,
    metadataJson,
    metadataBytes,
    displayJson,
    displayBytes,
    rawPayloadRefJson,
    rawPayloadRefBytes,
  };
}

export function compileProjectEventFilter(
  input: ProjectEventFilterV1,
  limits: ProjectEventLimits
): CompiledProjectEventFilter {
  if (!isPlainObject(input)) throw new ProjectEventValidationError('filter must be an object');
  if (input.version !== PROJECT_EVENT_FILTER_VERSION) {
    throw new ProjectEventValidationError('filter version must be 1');
  }
  for (const key of Object.keys(input)) {
    if (key !== 'version' && !FILTER_FIELD_SET.has(key)) {
      throw new ProjectEventValidationError(`filter field ${key} is not allowed`);
    }
  }

  const normalized: ProjectEventFilterV1 = { version: PROJECT_EVENT_FILTER_VERSION };
  const matchKeys: ProjectEventMatchKey[] = [];
  for (const field of PROJECT_EVENT_FILTER_FIELDS) {
    const values = normalizeFilterValues(input[field], field, limits);
    if (!values) continue;
    assignFilterValues(normalized, field, values);
    for (const value of values) {
      matchKeys.push({ field, value, matchKey: `${field}=${value}` });
    }
  }
  if (matchKeys.length === 0) {
    throw new ProjectEventValidationError('filter must include at least one allowlisted field');
  }
  if (matchKeys.length > limits.maxFilterMatchKeysPerSubscription) {
    throw new ProjectEventLimitExceededError(
      `filter compiles to more than ${limits.maxFilterMatchKeysPerSubscription} match keys`
    );
  }

  matchKeys.sort((a, b) => a.matchKey.localeCompare(b.matchKey));
  return {
    filter: normalized,
    fingerprint: stableStringify(normalized),
    matchKeys,
  };
}

export function projectEventKeys(
  event: Pick<ProjectEventRecord, 'source' | 'eventType' | 'subject' | 'severity'>
): string[] {
  return [
    `source=${event.source}`,
    `eventType=${event.eventType}`,
    `subjectType=${event.subject.type}`,
    `subjectId=${event.subject.id}`,
    `severity=${event.severity}`,
  ];
}

export function filterMatchesProjectEvent(
  filter: ProjectEventFilterV1,
  event: Pick<ProjectEventRecord, 'source' | 'eventType' | 'subject' | 'severity'>
): boolean {
  return (
    matchesFilterField(filter.source, event.source) &&
    matchesFilterField(filter.eventType, event.eventType) &&
    matchesFilterField(filter.subjectType, event.subject.type) &&
    matchesFilterField(filter.subjectId, event.subject.id) &&
    matchesFilterField(filter.severity, event.severity)
  );
}

function normalizeSeverity(value: unknown): ProjectEventSeverity {
  if (typeof value !== 'string' || !SEVERITY_SET.has(value)) {
    throw new ProjectEventValidationError('severity is not allowed');
  }
  return value as ProjectEventSeverity;
}

function assignFilterValues(
  filter: ProjectEventFilterV1,
  field: ProjectEventFilterField,
  values: string[]
): void {
  const assigned = values.length === 1 ? values[0] : values;
  switch (field) {
    case 'source':
      filter.source = assigned;
      break;
    case 'eventType':
      filter.eventType = assigned;
      break;
    case 'subjectType':
      filter.subjectType = assigned;
      break;
    case 'subjectId':
      filter.subjectId = assigned;
      break;
    case 'severity':
      filter.severity =
        values.length === 1
          ? normalizeSeverity(values[0])
          : values.map((value) => normalizeSeverity(value));
      break;
  }
}

function normalizeDisplay(
  input: AdmitProjectEventInput['display'],
  limits: ProjectEventLimits
): ProjectEventDisplayData {
  const display: ProjectEventDisplayData = {
    untrusted: true,
  };
  if (!input) return display;
  if (!isPlainObject(input)) throw new ProjectEventValidationError('display must be an object');
  display.title = normalizeOptionalText(input.title, 'display.title', limits.maxReasonBytes);
  display.summary = normalizeOptionalText(input.summary, 'display.summary', limits.maxDisplayBytes);
  display.url = normalizeOptionalText(input.url, 'display.url', limits.maxDisplayBytes);
  if (input.labels !== undefined) {
    if (!Array.isArray(input.labels)) {
      throw new ProjectEventValidationError('display.labels must be an array');
    }
    if (input.labels.length > limits.maxDisplayLabels) {
      throw new ProjectEventLimitExceededError(
        `display.labels must contain ${limits.maxDisplayLabels} entries or fewer`
      );
    }
    display.labels = input.labels.map((label, index) =>
      normalizeText(label, `display.labels[${index}]`, limits.maxFilterStringBytes)
    );
  }
  return sortJson(display) as ProjectEventDisplayData;
}

function normalizeRawPayloadRef(
  input: ProjectEventRawPayloadRef | null,
  limits: ProjectEventLimits
): ProjectEventRawPayloadRef | null {
  if (input === null) return null;
  if (!isPlainObject(input))
    throw new ProjectEventValidationError('rawPayloadRef must be an object');
  const ref: ProjectEventRawPayloadRef = {
    provider: normalizeNullableText(
      input.provider ?? null,
      'rawPayloadRef.provider',
      limits.maxFilterStringBytes
    ),
    uri: normalizeText(input.uri, 'rawPayloadRef.uri', limits.maxRawPayloadRefBytes),
    contentHash: normalizeNullableText(
      input.contentHash ?? null,
      'rawPayloadRef.contentHash',
      limits.maxFilterStringBytes
    ),
  };
  const bytes = byteLength(stableStringify(ref));
  if (bytes > limits.maxRawPayloadRefBytes) {
    throw new ProjectEventLimitExceededError(
      `rawPayloadRef must be ${limits.maxRawPayloadRefBytes} bytes or fewer`
    );
  }
  return ref;
}

function normalizeFilterValues(
  value: string | string[] | undefined,
  field: ProjectEventFilterField,
  limits: ProjectEventLimits
): string[] | null {
  if (value === undefined) return null;
  const values = Array.isArray(value) ? value : [value];
  if (values.length === 0) {
    throw new ProjectEventValidationError(`filter.${field} must not be empty`);
  }
  if (values.length > limits.maxFilterValuesPerField) {
    throw new ProjectEventLimitExceededError(
      `filter.${field} must contain ${limits.maxFilterValuesPerField} values or fewer`
    );
  }
  const normalized = normalizeStringSet(
    values,
    `filter.${field}`,
    values.length,
    limits.maxFilterStringBytes
  );
  if (field === 'severity') {
    for (const item of normalized) normalizeSeverity(item);
  }
  return normalized;
}

/** Canonical metadata normalization plus the stored byte budget. */
export function normalizeMetadataWithinBudget(
  input: ProjectEventMetadata,
  limits: ProjectEventLimits
): { metadata: ProjectEventMetadata; metadataJson: string; metadataBytes: number } {
  const metadata = normalizeMetadata(input, limits);
  const metadataJson = stableStringify(metadata);
  const metadataBytes = byteLength(metadataJson);
  if (metadataBytes > limits.maxMetadataBytes) {
    throw new ProjectEventLimitExceededError(
      `metadata must be ${limits.maxMetadataBytes} bytes or fewer`
    );
  }
  return { metadata, metadataJson, metadataBytes };
}

function normalizeMetadata(
  input: ProjectEventMetadata,
  limits: ProjectEventLimits
): ProjectEventMetadata {
  const stats = { keys: 0 };
  const normalized = normalizeJsonValue(input, limits, 0, stats, 'metadata');
  if (!isPlainObject(normalized)) {
    throw new ProjectEventValidationError('metadata must be an object');
  }
  return normalized as ProjectEventMetadata;
}

function deriveProjectEventAudience(
  projectId: string,
  source: string,
  metadata: ProjectEventMetadata
): ProjectEventAudience {
  if (source !== CREDENTIAL_LIMIT_EVENT_SOURCE) {
    return { scope: 'project', projectId, userId: null };
  }
  const credentialSource = metadataText(metadata, 'credentialSource');
  const visibilityScope = metadataText(metadata, 'visibilityScope');
  if (credentialSource === 'user' || visibilityScope === 'user') {
    return {
      scope: 'user',
      projectId,
      userId: metadataText(metadata, 'affectedUserId') ?? metadataText(metadata, 'userId'),
    };
  }
  if (
    credentialSource === 'project' ||
    credentialSource === 'platform' ||
    visibilityScope === 'project'
  ) {
    return { scope: 'project', projectId, userId: null };
  }
  return { scope: 'user', projectId, userId: null };
}

function metadataText(metadata: ProjectEventMetadata, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function matchesFilterField(expected: string | string[] | undefined, actual: string): boolean {
  if (expected === undefined) return true;
  return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
}
