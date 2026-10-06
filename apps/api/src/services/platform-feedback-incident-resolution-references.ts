const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

const EMPTY_RESOLUTION_REFERENCES = {
  fixPrUrl: null,
  dispatchedTaskId: null,
  linkedRecordId: null,
} as const satisfies IncidentResolutionReferences;

export interface IncidentResolutionReferenceInput {
  fixPrUrl?: string | null;
  dispatchedTaskId?: string | null;
  linkedRecordId?: string | null;
}

export interface IncidentResolutionReferences {
  fixPrUrl: string | null;
  dispatchedTaskId: string | null;
  linkedRecordId: string | null;
}

export class IncidentResolutionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IncidentResolutionValidationError';
  }
}

function stripControlCharacters(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function normalizeReferenceText(
  value: string | null | undefined,
  maxLength: number
): string | null {
  if (typeof value !== 'string') return null;
  const normalized = stripControlCharacters(value).replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function normalizeRecordId(
  value: string | null | undefined,
  fieldName: 'dispatchedTaskId' | 'linkedRecordId',
  maxLength: number
): string | null {
  const normalized = normalizeReferenceText(value, maxLength);
  if (!normalized) return null;
  if (!ULID_PATTERN.test(normalized)) {
    throw new IncidentResolutionValidationError(`${fieldName} must be a SAM task or Idea ULID`);
  }
  return normalized.toUpperCase();
}

function normalizePullRequestUrl(
  value: string | null | undefined,
  maxLength: number
): string | null {
  const normalized = normalizeReferenceText(value, maxLength);
  if (!normalized) return null;

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new IncidentResolutionValidationError('fixPrUrl must be a valid pull request URL');
  }

  if (url.protocol !== 'https:') {
    throw new IncidentResolutionValidationError('fixPrUrl must use https');
  }

  const pathSegments = url.pathname.split('/').filter(Boolean);
  const pullIndex = pathSegments.indexOf('pull');
  if (pullIndex === -1 || !/^\d+$/.test(pathSegments[pullIndex + 1] ?? '')) {
    throw new IncidentResolutionValidationError(
      'fixPrUrl must point to a pull request path such as /owner/repo/pull/123'
    );
  }

  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function normalizeIncidentResolutionReferences(
  input: IncidentResolutionReferenceInput | undefined,
  maxLength: number
): IncidentResolutionReferences {
  return {
    fixPrUrl: normalizePullRequestUrl(input?.fixPrUrl, maxLength),
    dispatchedTaskId: normalizeRecordId(input?.dispatchedTaskId, 'dispatchedTaskId', maxLength),
    linkedRecordId: normalizeRecordId(input?.linkedRecordId, 'linkedRecordId', maxLength),
  };
}

export function parseStoredIncidentResolutionReferences(
  raw: string | null | undefined
): IncidentResolutionReferences {
  if (!raw) return { ...EMPTY_RESOLUTION_REFERENCES };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { ...EMPTY_RESOLUTION_REFERENCES };
    }
    const record = parsed as Record<string, unknown>;
    return {
      fixPrUrl: typeof record.fixPrUrl === 'string' ? record.fixPrUrl : null,
      dispatchedTaskId:
        typeof record.dispatchedTaskId === 'string' ? record.dispatchedTaskId : null,
      linkedRecordId: typeof record.linkedRecordId === 'string' ? record.linkedRecordId : null,
    };
  } catch {
    return { ...EMPTY_RESOLUTION_REFERENCES };
  }
}

function hasIncidentResolutionReference(references: IncidentResolutionReferences): boolean {
  return Boolean(references.fixPrUrl || references.dispatchedTaskId || references.linkedRecordId);
}

export function serializeIncidentResolutionReferences(
  references: IncidentResolutionReferences
): string | null {
  return hasIncidentResolutionReference(references) ? JSON.stringify(references) : null;
}

export function requireIncidentResolutionContract(
  outcome: 'resolved' | 'rejected',
  note: string,
  references: IncidentResolutionReferences
): void {
  if (outcome === 'resolved' && !hasIncidentResolutionReference(references)) {
    throw new IncidentResolutionValidationError(
      'Resolved incidents require one ship-or-track reference: provide fixPrUrl (merged/open PR URL), dispatchedTaskId (implementation task ID), or linkedRecordId (Idea/task ID). Use outcome "rejected" with a justification note for expected-behavior or no-fix cases.'
    );
  }
  if (outcome === 'rejected' && !note.trim()) {
    throw new IncidentResolutionValidationError(
      'Rejected incidents require a justification note explaining why this is expected behavior or will not be fixed.'
    );
  }
}
