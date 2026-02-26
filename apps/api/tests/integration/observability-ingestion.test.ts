/**
 * Integration test: observability error ingestion pipeline.
 *
 * Verifies the end-to-end wiring of the error ingestion pipeline:
 * 1. Client errors route persists to OBSERVABILITY_DATABASE via persistErrorBatch
 * 2. VM agent errors route persists to OBSERVABILITY_DATABASE via persistErrorBatch
 * 3. API logger (createInstrumentedLogger) persists error-level entries to D1
 * 4. Scheduled purge is registered in the cron handler
 * 5. All three sources use fire-and-forget (waitUntil + catch) patterns
 * 6. Console.error is still called for all sources (CF Workers Observability)
 *
 * Uses source-code analysis to verify integration wiring without Miniflare,
 * consistent with existing integration test patterns in this project.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('observability error ingestion pipeline', () => {
  const clientErrorsRoute = readFileSync(resolve(process.cwd(), 'src/routes/client-errors.ts'), 'utf8');
  const nodesRoute = readFileSync(resolve(process.cwd(), 'src/routes/nodes.ts'), 'utf8');
  const loggerFile = readFileSync(resolve(process.cwd(), 'src/lib/logger.ts'), 'utf8');
  const observabilityService = readFileSync(resolve(process.cwd(), 'src/services/observability.ts'), 'utf8');
  const observabilitySchema = readFileSync(resolve(process.cwd(), 'src/db/observability-schema.ts'), 'utf8');
  const scheduledPurge = readFileSync(resolve(process.cwd(), 'src/scheduled/observability-purge.ts'), 'utf8');
  const indexFile = readFileSync(resolve(process.cwd(), 'src/index.ts'), 'utf8');

  // ===========================================================================
  // Schema & Service Layer
  // ===========================================================================
  describe('observability schema and service', () => {
    it('schema defines platform_errors table with required columns', () => {
      expect(observabilitySchema).toContain("'platform_errors'");
      expect(observabilitySchema).toContain("id: text('id').primaryKey()");
      expect(observabilitySchema).toContain("source: text('source').notNull()");
      expect(observabilitySchema).toContain("level: text('level').notNull()");
      expect(observabilitySchema).toContain("message: text('message').notNull()");
      expect(observabilitySchema).toContain("timestamp: integer('timestamp').notNull()");
    });

    it('schema defines all four required indexes', () => {
      expect(observabilitySchema).toContain('idx_platform_errors_timestamp');
      expect(observabilitySchema).toContain('idx_platform_errors_source_timestamp');
      expect(observabilitySchema).toContain('idx_platform_errors_level_timestamp');
      expect(observabilitySchema).toContain('idx_platform_errors_created_at');
    });

    it('service exports persistError and persistErrorBatch', () => {
      expect(observabilityService).toContain('export async function persistError(');
      expect(observabilityService).toContain('export async function persistErrorBatch(');
    });

    it('service exports queryErrors for downstream consumption', () => {
      expect(observabilityService).toContain('export async function queryErrors(');
    });

    it('persistError validates source against allowed set', () => {
      expect(observabilityService).toContain("VALID_SOURCES.has(input.source)");
    });

    it('persistError truncates message and stack to configurable limits', () => {
      expect(observabilityService).toContain('truncate(input.message, MAX_MESSAGE_LENGTH)');
      expect(observabilityService).toContain('truncate(input.stack, MAX_STACK_LENGTH)');
    });

    it('persistError is fail-silent (catches D1 errors)', () => {
      // The try/catch wraps the entire insert
      expect(observabilityService).toContain('} catch (err) {');
      expect(observabilityService).toContain('[observability] Failed to persist error:');
    });

    it('persistErrorBatch respects configurable batch size', () => {
      expect(observabilityService).toContain('OBSERVABILITY_ERROR_BATCH_SIZE');
      expect(observabilityService).toContain('inputs.slice(0, maxBatch)');
    });
  });

  // ===========================================================================
  // Client Errors → D1 Pipeline
  // ===========================================================================
  describe('client errors → D1 pipeline', () => {
    it('client-errors route imports persistErrorBatch from observability service', () => {
      expect(clientErrorsRoute).toContain("import { persistErrorBatch");
      expect(clientErrorsRoute).toContain("from '../services/observability'");
    });

    it('client-errors route imports PersistErrorInput type', () => {
      expect(clientErrorsRoute).toContain('type PersistErrorInput');
    });

    it('client-errors route collects persistInputs array', () => {
      expect(clientErrorsRoute).toContain('const persistInputs: PersistErrorInput[] = []');
    });

    it('client-errors route sets source to "client"', () => {
      expect(clientErrorsRoute).toContain("source: 'client'");
    });

    it('client-errors route calls persistErrorBatch with OBSERVABILITY_DATABASE', () => {
      expect(clientErrorsRoute).toContain('c.env.OBSERVABILITY_DATABASE');
      expect(clientErrorsRoute).toContain('persistErrorBatch(c.env.OBSERVABILITY_DATABASE, persistInputs');
    });

    it('client-errors route uses fire-and-forget pattern (catch + waitUntil)', () => {
      expect(clientErrorsRoute).toContain('.catch(() => {})');
      expect(clientErrorsRoute).toContain('c.executionCtx.waitUntil(promise)');
    });

    it('client-errors route still calls console.error for CF Workers Observability', () => {
      expect(clientErrorsRoute).toContain("console.error('[client-error]'");
    });

    it('client-errors route maps timestamp from client ISO string to epoch ms', () => {
      expect(clientErrorsRoute).toContain("new Date(e.timestamp).getTime()");
    });
  });

  // ===========================================================================
  // VM Agent Errors → D1 Pipeline
  // ===========================================================================
  describe('VM agent errors → D1 pipeline', () => {
    it('nodes route imports persistErrorBatch from observability service', () => {
      expect(nodesRoute).toContain("import { persistErrorBatch");
      expect(nodesRoute).toContain("from '../services/observability'");
    });

    it('nodes route collects persistInputs for vm-agent errors', () => {
      expect(nodesRoute).toContain('const persistInputs: PersistErrorInput[] = []');
    });

    it('nodes route sets source to "vm-agent"', () => {
      expect(nodesRoute).toContain("source: 'vm-agent'");
    });

    it('nodes route includes nodeId in persisted errors', () => {
      // The nodeId should be passed through to the persist input
      expect(nodesRoute).toContain('nodeId,');
    });

    it('nodes route calls persistErrorBatch with OBSERVABILITY_DATABASE', () => {
      expect(nodesRoute).toContain('persistErrorBatch(c.env.OBSERVABILITY_DATABASE, persistInputs');
    });

    it('nodes route uses fire-and-forget pattern (catch + waitUntil)', () => {
      expect(nodesRoute).toContain('.catch(() => {})');
      expect(nodesRoute).toContain('c.executionCtx.waitUntil(promise)');
    });

    it('nodes route still calls console.error for CF Workers Observability', () => {
      expect(nodesRoute).toContain("console.error('[vm-agent-error]'");
    });
  });

  // ===========================================================================
  // API Logger → D1 Pipeline
  // ===========================================================================
  describe('API logger → D1 pipeline', () => {
    it('logger imports persistError from observability service', () => {
      expect(loggerFile).toContain("import { persistError } from '../services/observability'");
    });

    it('logger exports createInstrumentedLogger factory', () => {
      expect(loggerFile).toContain('export function createInstrumentedLogger(');
    });

    it('instrumented logger accepts db and waitUntil parameters', () => {
      expect(loggerFile).toContain('db: D1Database | null');
      expect(loggerFile).toContain('waitUntil: ((promise: Promise<unknown>) => void) | null');
    });

    it('instrumented logger calls persistError on error-level entries', () => {
      // Search within the createInstrumentedLogger function body
      const fnStart = loggerFile.indexOf('export function createInstrumentedLogger(');
      const fnSection = loggerFile.slice(fnStart);
      expect(fnSection).toContain('persistError(db,');
    });

    it('instrumented logger sets source to "api"', () => {
      expect(loggerFile).toContain("source: 'api'");
    });

    it('instrumented logger uses waitUntil for fire-and-forget D1 writes', () => {
      const fnStart = loggerFile.indexOf('export function createInstrumentedLogger(');
      const fnSection = loggerFile.slice(fnStart);
      expect(fnSection).toContain('waitUntil(');
    });

    it('instrumented logger gracefully handles null db (no D1 write)', () => {
      expect(loggerFile).toContain('if (db && waitUntil)');
    });
  });

  // ===========================================================================
  // Scheduled Purge Registration
  // ===========================================================================
  describe('scheduled purge registration', () => {
    it('purge module imports purgeExpiredErrors from observability service', () => {
      expect(scheduledPurge).toContain("import { purgeExpiredErrors");
      expect(scheduledPurge).toContain("from '../services/observability'");
    });

    it('purge module exports runObservabilityPurge function', () => {
      expect(scheduledPurge).toContain('export async function runObservabilityPurge(');
    });

    it('purge module checks for OBSERVABILITY_DATABASE before purging', () => {
      expect(scheduledPurge).toContain('env.OBSERVABILITY_DATABASE');
    });

    it('purge module returns zero-result when no database is configured', () => {
      expect(scheduledPurge).toContain('deletedByAge: 0, deletedByCount: 0');
    });

    it('index.ts imports runObservabilityPurge', () => {
      expect(indexFile).toContain("import { runObservabilityPurge } from './scheduled/observability-purge'");
    });

    it('index.ts calls runObservabilityPurge in the scheduled handler', () => {
      expect(indexFile).toContain('runObservabilityPurge(env)');
    });

    it('index.ts logs observability purge results in cron.completed', () => {
      expect(indexFile).toContain('observabilityPurgedByAge');
      expect(indexFile).toContain('observabilityPurgedByCount');
    });
  });

  // ===========================================================================
  // Cross-Cutting: All Three Sources Use Consistent Patterns
  // ===========================================================================
  describe('cross-cutting consistency', () => {
    it('all three sources are represented: client, vm-agent, api', () => {
      expect(clientErrorsRoute).toContain("source: 'client'");
      expect(nodesRoute).toContain("source: 'vm-agent'");
      expect(loggerFile).toContain("source: 'api'");
    });

    it('observability service validates all three sources', () => {
      expect(observabilityService).toContain("'client'");
      expect(observabilityService).toContain("'vm-agent'");
      expect(observabilityService).toContain("'api'");
    });

    it('both route-based sources guard on OBSERVABILITY_DATABASE existence', () => {
      // Client errors route
      expect(clientErrorsRoute).toContain('c.env.OBSERVABILITY_DATABASE');
      // VM agent errors route
      expect(nodesRoute).toContain('c.env.OBSERVABILITY_DATABASE');
    });

    it('both route-based sources use try/catch for executionCtx.waitUntil', () => {
      // This pattern handles the missing executionCtx in test environments
      expect(clientErrorsRoute).toContain('try { c.executionCtx.waitUntil(promise)');
      expect(nodesRoute).toContain('try { c.executionCtx.waitUntil(promise)');
    });

    it('retention purge handles both age-based and count-based deletion', () => {
      expect(observabilityService).toContain('OBSERVABILITY_ERROR_RETENTION_DAYS');
      expect(observabilityService).toContain('OBSERVABILITY_ERROR_MAX_ROWS');
    });
  });
});
