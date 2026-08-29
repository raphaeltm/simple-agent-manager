import type {
  DefaultCapacityPoolCandidateCatalogAddition,
  DefaultCapacityPoolCandidateStatusUpdate,
  DefaultCapacityPoolPolicyUpdate,
  DefaultCapacityPoolUpdateRequest,
} from '@simple-agent-manager/shared';
import {
  isCapacityExhaustionPolicy,
  isCapacityPoolStatus,
  isCapacityPoolStrategy,
  isValidProvider,
} from '@simple-agent-manager/shared';

import { errors } from '../middleware/error';
import type { DefaultCapacityPoolUpdateResult } from '../services/default-capacity-pool-updates';

type JsonRequestContext = { req: { json(): Promise<unknown> } };

export async function readDefaultCapacityPoolUpdateRequest(
  c: JsonRequestContext
): Promise<DefaultCapacityPoolUpdateRequest> {
  try {
    return parseDefaultCapacityPoolUpdateRequest(await c.req.json());
  } catch (error) {
    if (isHttpError(error)) throw error;
    throw errors.badRequest('Request body must be valid JSON');
  }
}

export function assertDefaultCapacityPoolUpdateResult(
  result: DefaultCapacityPoolUpdateResult,
  missingCandidatesMessage: string
): void {
  if (!result.poolFound) throw errors.notFound('Default capacity pool');
  if (result.missingCandidateIds.length > 0) {
    throw errors.badRequest(missingCandidatesMessage, {
      missingCandidateIds: result.missingCandidateIds,
    });
  }
  if (result.unavailableCandidateIds.length > 0) {
    throw errors.badRequest('Candidate updates must be currently available in the provider catalog', {
      unavailableCandidateIds: result.unavailableCandidateIds,
    });
  }
  if (result.missingCatalogAdditions.length > 0) {
    throw errors.badRequest('Catalog additions must belong to the default capacity pool', {
      missingCatalogAdditions: result.missingCatalogAdditions,
    });
  }
  if (result.unavailableCatalogAdditions.length > 0) {
    throw errors.badRequest('Catalog additions must be currently available in the provider catalog', {
      unavailableCatalogAdditions: result.unavailableCatalogAdditions,
    });
  }

  return;
}

export function parseDefaultCapacityPoolUpdateRequest(
  body: unknown
): DefaultCapacityPoolUpdateRequest {
  const record = requireObject(body, 'Default capacity pool update must be a JSON object');
  const policy =
    record.policy === undefined
      ? undefined
      : parsePolicyUpdate(
          requireObject(record.policy, 'Default capacity pool policy update must be an object')
        );
  const candidates =
    record.candidates === undefined ? undefined : parseCandidateUpdates(record.candidates);
  const catalogAdditions =
    record.catalogAdditions === undefined
      ? undefined
      : parseCatalogAdditions(record.catalogAdditions);

  if (!policy && !candidates && !catalogAdditions) {
    throw errors.badRequest(
      'Default capacity pool update must include policy, candidates, or catalogAdditions'
    );
  }

  return {
    ...(policy ? { policy } : {}),
    ...(candidates ? { candidates } : {}),
    ...(catalogAdditions ? { catalogAdditions } : {}),
  };
}

function parsePolicyUpdate(
  record: Record<string, unknown>
): DefaultCapacityPoolPolicyUpdate | null {
  const strategy = optionalEnum(
    record,
    'strategy',
    isCapacityPoolStrategy,
    'Invalid default capacity pool strategy'
  );
  const exhaustionPolicy = optionalEnum(
    record,
    'exhaustionPolicy',
    isCapacityExhaustionPolicy,
    'Invalid default capacity pool exhaustion policy'
  );

  if (!strategy && !exhaustionPolicy) return null;
  return {
    ...(strategy ? { strategy } : {}),
    ...(exhaustionPolicy ? { exhaustionPolicy } : {}),
  };
}

function parseCandidateUpdates(value: unknown): DefaultCapacityPoolCandidateStatusUpdate[] {
  if (!Array.isArray(value)) {
    throw errors.badRequest('Default capacity pool candidate updates must be an array');
  }

  return value.map((candidate) => {
    const record = requireObject(
      candidate,
      'Default capacity pool candidate update must be an object'
    );
    return {
      id: requiredTrimmedString(record, 'id', 'Default capacity pool candidate id is required'),
      status: requiredEnum(
        record,
        'status',
        isCapacityPoolStatus,
        'Invalid default capacity pool candidate status'
      ),
    };
  });
}

function parseCatalogAdditions(value: unknown): DefaultCapacityPoolCandidateCatalogAddition[] {
  if (!Array.isArray(value)) {
    throw errors.badRequest('Default capacity pool catalog additions must be an array');
  }

  return value.map((addition) => {
    const record = requireObject(
      addition,
      'Default capacity pool catalog addition must be an object'
    );
    const provider = requiredTrimmedString(
      record,
      'provider',
      'Default capacity pool catalog addition provider is required'
    );
    if (!isValidProvider(provider)) {
      throw errors.badRequest('Invalid default capacity pool catalog addition provider');
    }
    return {
      sourceId: requiredTrimmedString(
        record,
        'sourceId',
        'Default capacity pool catalog addition source id is required'
      ),
      provider,
      location: requiredTrimmedString(
        record,
        'location',
        'Default capacity pool catalog addition location is required'
      ),
      providerInstanceType: requiredTrimmedString(
        record,
        'providerInstanceType',
        'Default capacity pool catalog addition provider instance type is required'
      ),
      providerInstanceSku: optionalNullableTrimmedString(record, 'providerInstanceSku'),
    };
  });
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw errors.badRequest(message);
  }
  return value as Record<string, unknown>;
}

function requiredTrimmedString(
  record: Record<string, unknown>,
  field: string,
  message: string
): string {
  const value = record[field];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw errors.badRequest(message);
  }
  return value.trim();
}

function optionalEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  isValid: (value: unknown) => value is T,
  message: string
): T | undefined {
  const value = record[field];
  if (value === undefined) return undefined;
  if (!isValid(value)) throw errors.badRequest(message);
  return value;
}

function optionalNullableTrimmedString(
  record: Record<string, unknown>,
  field: string
): string | null {
  const value = record[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw errors.badRequest(`Default capacity pool catalog addition ${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function requiredEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  isValid: (value: unknown) => value is T,
  message: string
): T {
  const value = optionalEnum(record, field, isValid, message);
  if (value === undefined) throw errors.badRequest(message);
  return value;
}

function isHttpError(error: unknown): boolean {
  return error instanceof Error && 'statusCode' in error;
}
