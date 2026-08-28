import type { DefaultCapacityPoolUpdateRequest } from '@simple-agent-manager/shared';
import {
  isCapacityExhaustionPolicy,
  isCapacityPoolStatus,
  isCapacityPoolStrategy,
} from '@simple-agent-manager/shared';

import { errors } from '../middleware/error';

export function parseDefaultCapacityPoolUpdateRequest(
  body: unknown
): DefaultCapacityPoolUpdateRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw errors.badRequest('Default capacity pool update must be a JSON object');
  }

  const record = body as Record<string, unknown>;
  const update: DefaultCapacityPoolUpdateRequest = {};

  if (record.policy !== undefined) {
    if (!record.policy || typeof record.policy !== 'object' || Array.isArray(record.policy)) {
      throw errors.badRequest('Default capacity pool policy update must be an object');
    }
    const policy = record.policy as Record<string, unknown>;

    if (policy.strategy !== undefined) {
      if (!isCapacityPoolStrategy(policy.strategy)) {
        throw errors.badRequest('Invalid default capacity pool strategy');
      }
      update.policy = { ...update.policy, strategy: policy.strategy };
    }

    if (policy.exhaustionPolicy !== undefined) {
      if (!isCapacityExhaustionPolicy(policy.exhaustionPolicy)) {
        throw errors.badRequest('Invalid default capacity pool exhaustion policy');
      }
      update.policy = {
        ...update.policy,
        exhaustionPolicy: policy.exhaustionPolicy,
      };
    }
  }

  if (record.candidates !== undefined) {
    if (!Array.isArray(record.candidates)) {
      throw errors.badRequest('Default capacity pool candidate updates must be an array');
    }

    update.candidates = record.candidates.map((candidate) => {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw errors.badRequest('Default capacity pool candidate update must be an object');
      }

      const candidateRecord = candidate as Record<string, unknown>;
      if (typeof candidateRecord.id !== 'string' || candidateRecord.id.trim().length === 0) {
        throw errors.badRequest('Default capacity pool candidate id is required');
      }
      if (!isCapacityPoolStatus(candidateRecord.status)) {
        throw errors.badRequest('Invalid default capacity pool candidate status');
      }

      return {
        id: candidateRecord.id.trim(),
        status: candidateRecord.status,
      };
    });
  }

  if (!update.policy && !update.candidates) {
    throw errors.badRequest('Default capacity pool update must include policy or candidates');
  }

  return update;
}
