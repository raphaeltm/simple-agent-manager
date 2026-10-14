/**
 * `apps/api/wrangler.toml` leaves out every `[vars]` entry whose value equals the code default,
 * because each entry is a Cloudflare text binding and a Worker may only carry so many. The names
 * and values left out are recorded in `OMITTED_WORKER_VAR_DEFAULTS`
 * (`scripts/deploy/worker-var-defaults.ts`). This suite proves the omission changes nothing, by
 * running the production read paths rather than comparing copied constants:
 *
 * 1. Every read path resolves the same configuration with the recorded values absent as with them
 *    present, for local/self-host inputs and for the staging and production GitHub Environments.
 * 2. Setting each omitted var to another value changes at least one read path, so (1) cannot pass
 *    because the paths ignore the var.
 * 3. Every source file that reads an omitted var is exercised by a read path that observes it, so a
 *    new read site with its own fallback cannot appear unnoticed (`.claude/rules/61`, requirement 2).
 *    Every omitted var must have a read site the scan finds, so a read the scan cannot see (a key
 *    built in some new way) fails here instead of leaving (3) vacuously true for that var.
 *
 * When a code default changes, (1) fails until the record in `worker-var-defaults.ts` changes with
 * it, so a deployed behaviour change is always deliberate (`.claude/rules/07`).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import * as TOML from '@iarna/toml';
import { resolveOrchestratorConfig } from '@simple-agent-manager/shared';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { OMITTED_WORKER_VAR_DEFAULTS } from '../../../../../scripts/deploy/worker-var-defaults';
import environmentVariables from '../../../../../scripts/quality/fixtures/github-environment-variables-2026-10-11.json';
import { resolveArchiveHashPageRows } from '../../../src/durable-objects/project-data/archive-sharding';
import {
  computeHumanInputSchedule,
  humanInputMaxWaitMs,
  humanInputUndeliveredGraceMs,
  parseHumanInputEscalationFractions,
} from '../../../src/durable-objects/project-data/attention';
import {
  resolveCommentLimits,
  resolveCommentListLimit,
  resolveProjectCommentListLimit,
  resolveProjectCommentListMaxBytes,
} from '../../../src/durable-objects/project-data/comment-normalization';
import { resolveMessageSearchBounds } from '../../../src/durable-objects/project-data/message-search';
import { resolveMaxMessagesPerSession } from '../../../src/durable-objects/project-data/messages-persist-helpers';
import { channelLimits } from '../../../src/durable-objects/project-data/project-event-channels-config';
import { scheduleLimits } from '../../../src/durable-objects/project-data/project-event-schedules-config';
import { resolveProjectEventLimits } from '../../../src/durable-objects/project-data/project-events-limits';
import {
  activeWorkHardStallMs,
  maxCandidatesPerSweep,
  minReconciliationAlarmDelayMs,
  reconciliationCandidateLeaseMs,
  reconciliationNodeCallTimeoutMs,
  reconciliationProbeMaxAttempts,
  reconciliationQuarantineMs,
} from '../../../src/durable-objects/project-data/reconciliation-thresholds';
import { resolveStorageSafetyConfig } from '../../../src/durable-objects/project-data/storage-safety';
import { resolveToolMetadataMaxBytes } from '../../../src/durable-objects/project-data/tool-metadata-storage';
import { resolveD1SessionMode } from '../../../src/lib/d1-session';
import { resolveSearchQueryLimits } from '../../../src/lib/search-query-limits';
import { getRateLimit } from '../../../src/middleware/rate-limit';
import { compactArchiveTimeout } from '../../../src/project-data-archive/compact-r2';
import { getMcpLimits } from '../../../src/routes/mcp/_helpers';
import { resolveMaxMessageBytes } from '../../../src/routes/workspaces/runtime';
import { throttleKey } from '../../../src/scheduled/failed-sweep-notifications';
import { resolveCleanupConfig } from '../../../src/scheduled/node-cleanup/config';
import { resolveOperatorNotificationThrottleMs } from '../../../src/scheduled/operator-notifications';
import {
  getProjectDataArchiveFrozenIntentInspectionConfig,
  resolveConfig as resolveArchiveCoordinatorConfig,
  scopedConfig as scopedArchiveCoordinatorConfig,
} from '../../../src/scheduled/project-data-archive-sharding';
import { configFromEnv as storageReliefPreflightConfig } from '../../../src/scheduled/project-data-storage-relief-preflight';
import { getAcpInteractionConfig } from '../../../src/services/acp-interaction-config';
import { buildAcpInteractionRuntimeConfig } from '../../../src/services/acp-interaction-runtime-config';
import { resolveCredentialLimitConfig } from '../../../src/services/credential-limit-events/config';
import { getCacheConfig as getDevcontainerCacheConfig } from '../../../src/services/devcontainer-cache';
import { resolveDiagnosisCompletedStepDelayMs } from '../../../src/services/diagnosis-runner-policy';
import { resolveDiagnosticIncidentConfig } from '../../../src/services/diagnostic-incident-config';
import { githubTriggerRecoveryConfig } from '../../../src/services/github-trigger-recovery-config';
import { getRuntimeLimits } from '../../../src/services/limits';
import {
  resolveDisabledAlarmRetryMs,
  resolveOperationalKillSwitchCacheMs,
  resolveOperationalLoopKvKey,
} from '../../../src/services/operational-kill-switch';
import {
  getProjectDataArchiveManualCanaryConfig,
  getProjectDataArchiveRolloutListConfig,
  getProjectDataArchiveRolloutWarningConfig,
} from '../../../src/services/project-data-archive-rollout-controls';
import {
  archiveShardProjectDataOwner,
  resolveArchiveShardCount,
} from '../../../src/services/project-data-archive-routing';
import { resolveProjectEventSourceOutboxConfig } from '../../../src/services/project-event-source-outbox-contract';
import { resolveMonthlyCap, resolveWorkspaceTtlMs } from '../../../src/services/trial/helpers';
import { resolveTrialsEnabledKvKey } from '../../../src/services/trial/kill-switch';
import { resolveTrialRunnerConfig } from '../../../src/services/trial/trial-runner';
import { getVmAdmissionConfig } from '../../../src/services/vm-admission-control-types';
import {
  areWebhookTriggersEnabled,
  getWebhookTriggerLimits,
} from '../../../src/services/webhook-trigger-config';

type WorkerVars = Record<string, string>;

/** One production read path: the function the Worker calls, and the files whose reads it covers. */
interface ReadPath {
  label: string;
  /** Repository-relative files whose reads of omitted vars this path exercises. */
  sources: readonly string[];
  read: (env: WorkerVars) => unknown;
}

// The production functions are typed against the Worker `Env`; tests hand them plain var maps.
const asEnv = <T>(env: WorkerVars): T => env as unknown as T;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const API = 'apps/api/src';

const READ_PATHS: readonly ReadPath[] = [
  {
    label: 'resolveD1SessionMode',
    sources: [`${API}/lib/d1-session.ts`],
    read: (env) => resolveD1SessionMode(env),
  },
  {
    label: 'operational kill switches',
    sources: [`${API}/services/operational-kill-switch.ts`],
    read: (env) => [
      resolveOperationalLoopKvKey(env, 'cron'),
      resolveOperationalLoopKvKey(env, 'alarms'),
      resolveOperationalKillSwitchCacheMs(env),
      resolveDisabledAlarmRetryMs(env),
    ],
  },
  {
    label: 'failed-sweep operator notifications',
    sources: [
      `${API}/scheduled/operator-notifications.ts`,
      `${API}/scheduled/failed-sweep-notifications.ts`,
    ],
    read: (env) => [
      resolveOperatorNotificationThrottleMs(asEnv(env)),
      throttleKey(asEnv(env), 'x'),
    ],
  },
  {
    label: 'getRateLimit(PUSH_SUBSCRIPTION)',
    sources: [`${API}/middleware/rate-limit.ts`],
    read: (env) => getRateLimit(asEnv(env), 'PUSH_SUBSCRIPTION'),
  },
  {
    // attention-expiry.ts hands the raw values to the same exported parsers.
    label: 'human-input schedule',
    sources: [
      `${API}/durable-objects/project-data/attention.ts`,
      `${API}/durable-objects/project-data/attention-expiry.ts`,
    ],
    read: (env) => [
      computeHumanInputSchedule(env, 0),
      parseHumanInputEscalationFractions(env.HUMAN_INPUT_ESCALATION_FRACTIONS),
      humanInputMaxWaitMs(env.HUMAN_INPUT_MAX_WAIT_MS),
      humanInputUndeliveredGraceMs(env.HUMAN_INPUT_UNDELIVERED_GRACE_MS),
    ],
  },
  {
    label: 'getRuntimeLimits',
    sources: [`${API}/services/limits.ts`],
    read: (env) => getRuntimeLimits(env),
  },
  {
    label: 'resolveMaxMessagesPerSession',
    sources: [`${API}/durable-objects/project-data/messages-persist-helpers.ts`],
    read: (env) => resolveMaxMessagesPerSession(asEnv(env)),
  },
  {
    label: 'comment limits',
    sources: [`${API}/durable-objects/project-data/comment-normalization.ts`],
    read: (env) => [
      resolveCommentLimits(asEnv(env)),
      resolveCommentListLimit(asEnv(env), undefined),
      resolveCommentListLimit(asEnv(env), Number.MAX_SAFE_INTEGER),
      resolveProjectCommentListLimit(asEnv(env), undefined),
      resolveProjectCommentListLimit(asEnv(env), Number.MAX_SAFE_INTEGER),
      resolveProjectCommentListMaxBytes(asEnv(env)),
    ],
  },
  {
    label: 'resolveToolMetadataMaxBytes',
    sources: [`${API}/durable-objects/project-data/tool-metadata-storage.ts`],
    read: (env) => resolveToolMetadataMaxBytes(asEnv(env)),
  },
  {
    label: 'resolveStorageSafetyConfig',
    sources: [`${API}/durable-objects/project-data/storage-safety.ts`],
    read: (env) => resolveStorageSafetyConfig(asEnv(env)),
  },
  {
    label: 'storage-relief preflight config',
    sources: [`${API}/scheduled/project-data-storage-relief-preflight.ts`],
    read: (env) => storageReliefPreflightConfig(asEnv(env)),
  },
  {
    label: 'archive coordinator config',
    sources: [`${API}/scheduled/project-data-archive-sharding.ts`],
    read: (env) => {
      const config = resolveArchiveCoordinatorConfig(asEnv(env));
      return [
        config,
        // Requests above every cap, so the result exposes the canary ceilings.
        scopedArchiveCoordinatorConfig(asEnv(env), config, {
          limit: Number.MAX_SAFE_INTEGER,
          wallTimeMs: Number.MAX_SAFE_INTEGER,
        }),
        getProjectDataArchiveFrozenIntentInspectionConfig(asEnv(env)),
      ];
    },
  },
  {
    // Every ProjectData archive read site calls this shared parser on the raw value.
    label: 'compactArchiveTimeout',
    sources: [
      `${API}/project-data-archive/compact-r2.ts`,
      `${API}/durable-objects/project-data/archive-sharding.ts`,
      `${API}/durable-objects/project-data/compact-archive.ts`,
    ],
    read: (env) => compactArchiveTimeout(env.PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS),
  },
  {
    label: 'resolveArchiveHashPageRows',
    sources: [`${API}/durable-objects/project-data/archive-sharding.ts`],
    read: (env) => resolveArchiveHashPageRows(env),
  },
  {
    label: 'archive shard routing',
    sources: [`${API}/services/project-data-archive-routing.ts`],
    read: (env) => [
      resolveArchiveShardCount(asEnv(env)),
      archiveShardProjectDataOwner(asEnv(env), 'project-1', 'session-1', 1),
    ],
  },
  {
    label: 'archive rollout controls',
    sources: [`${API}/services/project-data-archive-rollout-controls.ts`],
    read: (env) => [
      getProjectDataArchiveRolloutListConfig(asEnv(env)),
      getProjectDataArchiveManualCanaryConfig(asEnv(env)),
      getProjectDataArchiveRolloutWarningConfig(asEnv(env)),
    ],
  },
  {
    label: 'search query limits',
    sources: [
      `${API}/lib/search-query-limits.ts`,
      `${API}/durable-objects/project-data/message-search.ts`,
    ],
    read: (env) => [resolveSearchQueryLimits(env), resolveMessageSearchBounds(env)],
  },
  {
    label: 'resolveMaxMessageBytes',
    sources: [`${API}/routes/workspaces/runtime.ts`],
    read: (env) => resolveMaxMessageBytes(asEnv(env)),
  },
  {
    label: 'resolveDiagnosticIncidentConfig',
    sources: [`${API}/services/diagnostic-incident-config.ts`],
    read: (env) => resolveDiagnosticIncidentConfig(asEnv(env)),
  },
  {
    label: 'getVmAdmissionConfig',
    sources: [`${API}/services/vm-admission-control-types.ts`],
    read: (env) => getVmAdmissionConfig(asEnv(env)),
  },
  {
    // The cache config only exists once the cache is on and has an account to mint against.
    label: 'devcontainer cache config',
    sources: [`${API}/services/devcontainer-cache.ts`],
    read: (env) =>
      getDevcontainerCacheConfig(
        asEnv({
          ...env,
          DEVCONTAINER_CACHE_ENABLED: 'true',
          CF_ACCOUNT_ID: 'account',
          CF_API_TOKEN: 'token',
        })
      ),
  },
  {
    label: 'resolveCleanupConfig',
    sources: [`${API}/scheduled/node-cleanup/config.ts`],
    read: (env) => resolveCleanupConfig(asEnv(env)),
  },
  {
    // diagnosis-runner.ts hands the raw value to this exported parser.
    label: 'resolveDiagnosisCompletedStepDelayMs',
    sources: [
      `${API}/services/diagnosis-runner-policy.ts`,
      `${API}/durable-objects/diagnosis-runner.ts`,
    ],
    read: (env) => resolveDiagnosisCompletedStepDelayMs(env.DIAGNOSIS_COMPLETED_STEP_MIN_DELAY_MS),
  },
  {
    label: 'resolveOrchestratorConfig',
    sources: ['packages/shared/src/constants/orchestrator.ts'],
    read: (env) => resolveOrchestratorConfig(env),
  },
  {
    label: 'task reconciliation thresholds',
    sources: [`${API}/durable-objects/project-data/reconciliation-thresholds.ts`],
    read: (env) => [
      activeWorkHardStallMs(asEnv(env)),
      minReconciliationAlarmDelayMs(asEnv(env)),
      maxCandidatesPerSweep(asEnv(env)),
      reconciliationNodeCallTimeoutMs(asEnv(env)),
      reconciliationCandidateLeaseMs(asEnv(env)),
      reconciliationProbeMaxAttempts(asEnv(env)),
      reconciliationQuarantineMs(asEnv(env)),
    ],
  },
  {
    label: 'ACP interaction config',
    sources: [`${API}/services/acp-interaction-config.ts`],
    read: (env) => [
      getAcpInteractionConfig(env),
      buildAcpInteractionRuntimeConfig(asEnv(env), 'task'),
      buildAcpInteractionRuntimeConfig(asEnv(env), 'conversation'),
    ],
  },
  {
    label: 'GitHub trigger recovery config',
    sources: [`${API}/services/github-trigger-recovery-config.ts`],
    read: (env) => githubTriggerRecoveryConfig(asEnv(env)),
  },
  {
    label: 'webhook trigger config',
    sources: [`${API}/services/webhook-trigger-config.ts`],
    read: (env) => [areWebhookTriggersEnabled(asEnv(env)), getWebhookTriggerLimits(asEnv(env))],
  },
  {
    label: 'trial config',
    sources: [
      `${API}/services/trial/helpers.ts`,
      `${API}/services/trial/kill-switch.ts`,
      `${API}/services/trial/trial-runner.ts`,
    ],
    read: (env) => [
      resolveMonthlyCap(asEnv(env)),
      resolveWorkspaceTtlMs(asEnv(env)),
      resolveTrialsEnabledKvKey(asEnv(env)),
      resolveTrialRunnerConfig(asEnv({ ...env, ENVIRONMENT: 'staging' })),
      resolveTrialRunnerConfig(asEnv({ ...env, ENVIRONMENT: 'production' })),
    ],
  },
  {
    label: 'project event limits',
    sources: [
      `${API}/durable-objects/project-data/project-events-limits.ts`,
      `${API}/routes/mcp/_helpers.ts`,
    ],
    read: (env) => [resolveProjectEventLimits(asEnv(env)), getMcpLimits(asEnv(env))],
  },
  {
    label: 'project event schedule limits',
    sources: [`${API}/durable-objects/project-data/project-event-schedules-config.ts`],
    read: (env) => scheduleLimits(env),
  },
  {
    label: 'project event channel limits',
    sources: [`${API}/durable-objects/project-data/project-event-channels-config.ts`],
    read: (env) => channelLimits(env),
  },
  {
    label: 'project event source outbox config',
    sources: [`${API}/services/project-event-source-outbox-contract.ts`],
    read: (env) => resolveProjectEventSourceOutboxConfig(asEnv(env)),
  },
  {
    label: 'credential limit config',
    sources: [`${API}/services/credential-limit-events/config.ts`],
    read: (env) => resolveCredentialLimitConfig(asEnv(env)),
  },
];

/**
 * A value a read path accepts that differs from the recorded one, for the vars where the generic
 * rule below would be rejected or clamped back to the default by validation.
 */
const ALTERNATIVE_VALUES: Readonly<Record<string, string>> = {
  D1_SESSION_MODE: 'disabled',
  HUMAN_INPUT_ESCALATION_FRACTIONS: '0.5',
  TRIAL_AGENT_TYPE_STAGING: 'claude-code',
  TRIAL_AGENT_TYPE_PRODUCTION: 'opencode',
  // The lease is floored at the probe timeout plus a margin (35000 by default), above 30000.
  TASK_RECONCILIATION_CANDIDATE_LEASE_MS: '60000',
};

function alternativeValue(name: string, value: string): string {
  const explicit = ALTERNATIVE_VALUES[name];
  if (explicit !== undefined) return explicit;
  if (value === 'true') return 'false';
  if (value === 'false') return 'true';
  if (value === '') return '7';
  if (/^\d+$/.test(value)) return String(Number(value) > 1 ? Number(value) - 1 : Number(value) + 1);
  if (/^\d*\.\d+$/.test(value)) return String(Math.round((Number(value) - 0.01) * 100) / 100);
  return `${value}-alt`;
}

function shippedVars(): WorkerVars {
  const parsed = TOML.parse(
    readFileSync(path.join(REPO_ROOT, 'apps/api/wrangler.toml'), 'utf8')
  ) as { vars?: Record<string, unknown> };
  return Object.fromEntries(
    Object.entries(parsed.vars ?? {}).map(([name, value]) => [name, String(value)])
  );
}

const INPUTS: ReadonlyArray<{ label: string; overrides: WorkerVars }> = [
  { label: 'local and self-host (no overrides)', overrides: {} },
  { label: 'staging GitHub Environment', overrides: environmentVariables.staging.variables },
  { label: 'production GitHub Environment', overrides: environmentVariables.production.variables },
];

/** An env key built at runtime from an upper-case prefix: `RATE_LIMIT_${key}` or `'RATE_LIMIT_' + key`. */
const BUILT_KEY_PREFIX = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_$/;
const BUILDS_A_KEY = /`[A-Z][A-Z0-9_]*_\$\{|['"][A-Z][A-Z0-9_]*_['"]\s*\+/;

function builtKeyPrefix(node: ts.Node): string | undefined {
  if (ts.isTemplateExpression(node) && BUILT_KEY_PREFIX.test(node.head.text)) {
    return node.head.text;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
    ts.isStringLiteralLike(node.left) &&
    BUILT_KEY_PREFIX.test(node.left.text)
  ) {
    return node.left.text;
  }
  return undefined;
}

/**
 * Repository files that read `names` as values (types, interfaces and comments excluded).
 *
 * A key built at runtime never spells out the name it reads (`getRateLimit` reads
 * `RATE_LIMIT_PUSH_SUBSCRIPTION` as `RATE_LIMIT_${key}`), so such a construction counts as a read
 * of every name its prefix can produce. Any other indirection (a name table, a computed lookup)
 * leaves a name with no read site at all, which the coverage test reports as unreferenced.
 */
function valueReferences(names: ReadonlySet<string>): Map<string, Set<string>> {
  const roots = [
    'apps/api/src',
    'apps/tail-worker/src',
    'packages/shared/src',
    'packages/providers/src',
    'packages/cloud-init/src',
  ];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') walk(relative);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name)) {
        files.push(relative);
      }
    }
  };
  roots.forEach(walk);

  // Parse only files that mention a name or build a key; the AST pass then drops types and comments.
  const mentionsAnyName = new RegExp(`\\b(?:${[...names].join('|')})\\b`);
  const filesByName = new Map<string, Set<string>>();
  const addReference = (name: string, file: string): void => {
    const set = filesByName.get(name) ?? new Set<string>();
    set.add(file);
    filesByName.set(name, set);
  };
  for (const file of files) {
    const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
    if (!mentionsAnyName.test(text) && !BUILDS_A_KEY.test(text)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node, inType: boolean): void => {
      const typeOnly =
        inType ||
        ts.isTypeNode(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node);
      // An object-literal key is a name, not a read of the binding (e.g. a defaults table).
      const parent = node.parent as ts.Node | undefined;
      const isObjectKey =
        parent !== undefined && ts.isPropertyAssignment(parent) && parent.name === node;
      if (
        !typeOnly &&
        !isObjectKey &&
        (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) &&
        names.has(node.text)
      ) {
        addReference(node.text, file);
      }
      const prefix = typeOnly ? undefined : builtKeyPrefix(node);
      if (prefix !== undefined) {
        for (const name of names) if (name.startsWith(prefix)) addReference(name, file);
      }
      ts.forEachChild(node, (child) => visit(child, typeOnly));
    };
    visit(source, false);
  }
  return filesByName;
}

describe('Worker vars omitted from wrangler.toml because they equal the code default', () => {
  const omitted = OMITTED_WORKER_VAR_DEFAULTS;
  const shipped = shippedVars();

  it('omits each recorded var from wrangler.toml [vars]', () => {
    expect(Object.keys(omitted).length).toBeGreaterThan(150);
    expect(Object.keys(omitted).filter((name) => name in shipped)).toEqual([]);
  });

  for (const { label, overrides } of INPUTS) {
    it(`resolves every read path identically without the recorded values (${label})`, () => {
      const after = { ...shipped, ...overrides };
      const before = { ...shipped, ...omitted, ...overrides };
      for (const readPath of READ_PATHS) {
        expect(readPath.read(after), readPath.label).toEqual(readPath.read(before));
      }
    });
  }

  // Parses every source file that mentions an omitted name, so allow for a loaded CI runner.
  it('observes every omitted var through a read path that covers each file reading it', () => {
    const base = { ...shipped };
    const references = valueReferences(new Set(Object.keys(omitted)));
    // A broken scan would report every var as covered; it must find the bulk of the read sites.
    expect(
      [...references.values()].reduce((count, files) => count + files.size, 0)
    ).toBeGreaterThan(150);

    // A var read only through an indirection the scan cannot see would make the coverage check
    // below vacuous for it, so every omitted var must have at least one read site found.
    expect(
      Object.keys(omitted).filter((name) => !references.has(name)),
      'omitted vars with no read site the scan can see'
    ).toEqual([]);

    const unobserved: string[] = [];
    const uncovered: string[] = [];
    for (const [name, value] of Object.entries(omitted)) {
      const changed = { ...base, [name]: alternativeValue(name, value) };
      const observing = READ_PATHS.filter(
        (readPath) => !isDeepStrictEqual(readPath.read(changed), readPath.read(base))
      );
      if (observing.length === 0) unobserved.push(name);
      const covered = new Set(observing.flatMap((readPath) => readPath.sources));
      for (const file of references.get(name) ?? []) {
        if (!covered.has(file)) uncovered.push(`${name} read in ${file}`);
      }
    }
    expect(unobserved, 'no read path changes when these vars change').toEqual([]);
    expect(uncovered, 'read sites no observing read path exercises').toEqual([]);
  }, 60_000);
});
