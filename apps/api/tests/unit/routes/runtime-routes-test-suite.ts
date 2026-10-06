import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { createRouteTestApp } from './route-test-app';

/**
 * Shared behavioral test suite for runtime env-var routes. Skill runtime and
 * profile runtime expose the same runtime asset surface (a skill is a profile
 * override layer), so their route behavior — list/mask, create/encrypt, scope
 * rejection, delete — is identical apart from the entity name in the path and
 * insert payload. Centralizing the suite keeps the two route families in lock
 * step and avoids duplicated harness + assertions across the two test files.
 *
 * vi.hoisted/vi.mock blocks must remain in each caller file (hoisting is
 * per-module and mock paths must be literal), so the caller passes its hoisted
 * `mocks` object in here.
 */
export interface RuntimeRouteTestConfig {
  /** Entity noun used in test descriptions, e.g. 'skill' or 'profile'. */
  entityLabel: string;
  /** Route base path for createRouteTestApp, with :param segments. */
  basePath: string;
  /** The Hono runtime routes under test. */
  routes: Hono<{ Bindings: Env }>;
  /** Concrete request URL prefix (params resolved), no trailing slash. */
  requestPrefix: string;
  /** Concrete env-vars URL for an entity outside the project (404 case). */
  outsideEntityEnvVarsPath: string;
  /** The owning entity row returned by the scope lookup. */
  entityRow: Record<string, unknown>;
  /** ISO timestamp used for the env var row fixtures. */
  rowTimestamp: string;
  /** Entity-specific columns expected in the insert payload, e.g. { skillId }. */
  expectedInsertEntity: Record<string, unknown>;
  /** Caller's hoisted mocks for project auth + encryption. */
  mocks: {
    requireProjectAccess: ReturnType<typeof vi.fn>;
    requireProjectCapability: ReturnType<typeof vi.fn>;
    encrypt: ReturnType<typeof vi.fn>;
  };
}

export function runRuntimeRouteTests(config: RuntimeRouteTestConfig): void {
  const {
    entityLabel,
    basePath,
    routes,
    requestPrefix,
    outsideEntityEnvVarsPath,
    entityRow,
    rowTimestamp,
    expectedInsertEntity,
    mocks,
  } = config;

  describe(`${entityLabel} runtime routes`, () => {
    let app: Hono<{ Bindings: Env }>;
    let mockDB: any;
    let limitResponses: any[];
    let whereResponses: any[];
    let orderByResponses: any[];
    const runtimeBindings = {
      DATABASE: {} as any,
      ENCRYPTION_KEY: 'test-key',
    } as Env;

    const envVarRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
      envKey: 'API_TOKEN',
      storedValue: 'enc-value',
      valueIv: 'enc-iv',
      isSecret: true,
      createdAt: rowTimestamp,
      updatedAt: rowTimestamp,
      ...overrides,
    });

    const requestRuntime = (path: string, init: RequestInit) =>
      app.request(`${requestPrefix}${path}`, init, runtimeBindings);

    beforeEach(() => {
      vi.clearAllMocks();
      limitResponses = [];
      whereResponses = [];
      orderByResponses = [];

      const makeQueryBuilder = (isCountQuery = false): any => {
        const queryBuilder = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn(() => {
            if (isCountQuery) {
              return Promise.resolve(whereResponses.shift() ?? []);
            }
            return queryBuilder;
          }),
          limit: vi.fn(() => Promise.resolve(limitResponses.shift() ?? [])),
          orderBy: vi.fn(() => Promise.resolve(orderByResponses.shift() ?? [])),
        };
        return queryBuilder;
      };

      mockDB = {
        select: vi.fn((fields?: Record<string, unknown>) => makeQueryBuilder(Boolean(fields?.count))),
        insert: vi.fn().mockReturnThis(),
        values: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        delete: vi.fn().mockReturnThis(),
        where: vi.fn().mockResolvedValue(undefined),
      };

      (drizzle as any).mockReturnValue(mockDB);
      mocks.requireProjectAccess.mockResolvedValue({ id: 'proj-1', userId: 'owner-1' });
      mocks.requireProjectCapability.mockResolvedValue({ id: 'proj-1', userId: 'owner-1' });
      mocks.encrypt.mockResolvedValue({ ciphertext: 'enc-value', iv: 'enc-iv' });

      app = createRouteTestApp(basePath, routes);
    });

    it(`lists ${entityLabel} env vars with secret values masked`, async () => {
      limitResponses.push([entityRow]);
      orderByResponses.push([envVarRow({ storedValue: 'encrypted-token', valueIv: 'iv' })], []);

      const res = await requestRuntime('/env-vars', { method: 'GET' });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.envVars).toEqual([
        expect.objectContaining({
          key: 'API_TOKEN',
          value: null,
          isSecret: true,
          hasValue: true,
        }),
      ]);
    });

    it(`creates encrypted secret ${entityLabel} env vars`, async () => {
      limitResponses.push([entityRow], []);
      whereResponses.push([{ count: 0 }]);
      orderByResponses.push([envVarRow()], []);

      const res = await requestRuntime('/env-vars', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'API_TOKEN', value: 'plain-secret', isSecret: true }),
      });

      expect(res.status).toBe(200);
      expect(mocks.encrypt).toHaveBeenCalledWith('plain-secret', 'test-key');
      expect(mockDB.insert).toHaveBeenCalled();
      expect(mockDB.values).toHaveBeenCalledWith(expect.objectContaining({
        ...expectedInsertEntity,
        userId: 'user-1',
        envKey: 'API_TOKEN',
        storedValue: 'enc-value',
        valueIv: 'enc-iv',
        isSecret: true,
      }));
    });

    it(`rejects ${entityLabel} runtime access when the ${entityLabel} is outside the project`, async () => {
      limitResponses.push([]);

      const res = await app.request(outsideEntityEnvVarsPath, {
        method: 'GET',
      }, runtimeBindings);

      expect(res.status).toBe(404);
    });

    it(`deletes ${entityLabel} env vars after validating the key`, async () => {
      limitResponses.push([entityRow]);
      orderByResponses.push([], []);

      const res = await requestRuntime('/env-vars/API_TOKEN', {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      expect(mockDB.delete).toHaveBeenCalled();
    });
  });
}
