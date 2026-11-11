/**
 * Translate the top-level `apps/api/wrangler.toml` into a celld `wrangler.json`.
 *
 * celld (https://celld.dev) reads Wrangler JSON only and stops a deploy on any key it
 * does not know, so this is an explicit translation table rather than a filter: every
 * top-level key in wrangler.toml must have a rule here, and an unknown key throws. That
 * way a new Cloudflare-only binding cannot slip into (or silently out of) a self-hosted
 * deployment.
 *
 * This module is pure. Filesystem work (symlinks, writing the file) lives in
 * `celld-project.ts`. The Cloudflare pipeline (`scripts/deploy/sync-wrangler-config.ts`)
 * never imports it.
 */

import { resolveDurableObjectMigrations } from '../deploy/durable-object-migrations.js';
import type { MigrationEntry, WranglerToml } from '../deploy/types.js';
import {
  GUIDED_LOGIN_CONTAINER_CLASS,
  type GuidedLoginSettings,
  SANDBOX_IMAGE_DIR,
} from './guided-login.js';

/** Worker vars set for every celld deployment, overriding wrangler.toml [vars]. */
export const SELFHOST_VAR_OVERRIDES: Readonly<Record<string, string>> = {
  // Cloudflare Containers: Instant sessions and the Sandbox SDK. celld's container fence
  // blocks container -> host traffic on a one-box install (idea 01M72M9AEB933ZY8269D376DKC).
  CF_CONTAINER_ENABLED: 'false',
  SANDBOX_ENABLED: 'false',
  // Cloudflare Artifacts (SAM-native git repos); the binding is dropped below.
  ARTIFACTS_ENABLED: 'false',
  // Managed devcontainer cache uses the Cloudflare container registry API.
  DEVCONTAINER_CACHE_ENABLED: 'false',
  // AI proxy and the control plane's own LLM features go through AI Gateway / Workers AI.
  AI_PROXY_ENABLED: 'false',
  TTS_ENABLED: 'false',
  TASK_TITLE_GENERATION_ENABLED: 'false',
  STALLED_TASK_CLASSIFIER_ENABLED: 'false',
  // Analytics Engine and the AI Gateway cost reports.
  ANALYTICS_ENABLED: 'false',
  ANALYTICS_INGEST_ENABLED: 'false',
  COST_MONITORING_ENABLED: 'false',
  // wrangler.toml ships AI_GATEWAY_ID="sam". Empty makes every gateway consumer take its
  // no-gateway branch (direct Anthropic/OpenAI URLs, no AI Gateway log or cost queries).
  AI_GATEWAY_ID: '',
  // The container DO classes stay bound (index.ts exports them) but celld runs no container
  // behind VmAgentContainer: Instant is never available on a box. The sandbox class has its own
  // declaration (SANDBOX_CONTAINER_RUNTIME_AVAILABLE), set below only when guided login is on.
  CONTAINER_RUNTIME_AVAILABLE: 'false',
  SANDBOX_CONTAINER_RUNTIME_AVAILABLE: 'false',
  // Nodes reach the box through frps on loopback instead of per-node Cloudflare DNS/tunnels
  // (reverse-tunnel transport, sibling task T2 on sam/selfhost-pass-2).
  VM_AGENT_TRANSPORT: 'reverse-tunnel',
  // The environment label that, with SAM_INSTALLATION_ID, scopes provider resources to this
  // install (node-provider-labels.ts). Cloudflare deploys set staging/production in
  // sync-wrangler-config.ts; unset, a node whose create response was lost can never be
  // recovered ("Allocation ownership scope is unavailable") and the provider-orphan sweep is
  // skipped. Verified on the T4 GCP box.
  ENVIRONMENT: 'selfhost',
};

/** Keys the generator owns. Values a caller passes for these are rejected. */
const GENERATED_VAR_KEYS = [
  'BASE_DOMAIN',
  'R2_BUCKET_NAME',
  'SANDBOX_CONTAINER_RUNTIME_AVAILABLE',
] as const;

export interface CelldD1Database {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir: string;
}

export interface CelldAssets {
  directory: string;
  binding: string;
  not_found_handling: 'single-page-application';
  run_worker_first: true;
}

export interface CelldWranglerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  vars: Record<string, string>;
  d1_databases: CelldD1Database[];
  kv_namespaces: Array<{ binding: string; id: string }>;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
  durable_objects: { bindings: Array<{ name: string; class_name: string }> };
  migrations: Array<{ tag: string; new_sqlite_classes: string[] }>;
  triggers: { crons: string[] };
  assets?: CelldAssets;
  containers?: CelldContainer[];
}

/** celld accepts class_name, image, name, instance_type, max_instances and runtime. */
export interface CelldContainer {
  class_name: string;
  image: string;
  instance_type: string;
  max_instances?: number;
  runtime?: string;
}

/** One flat migrations directory to materialise inside the project dir. */
export interface MigrationDirPlan {
  databaseName: string;
  /** Relative to the project dir; celld requires a path inside it with no `..`. */
  projectRelativeDir: string;
  /** Relative to apps/api: the real directory the .sql files live in. */
  sourceDir: string;
}

export interface CelldConfigPlan {
  config: CelldWranglerConfig;
  migrationDirs: MigrationDirPlan[];
  /** Human-readable account of every dropped or translated key. */
  report: string[];
}

export interface CelldConfigOptions {
  /** `main` relative to the project dir (the project dir mirrors apps/api/src via a symlink). */
  main: string;
  baseDomain: string;
  /** Web UI build directory relative to the project dir. Omit to deploy the API only. */
  assetsDirectory?: string;
  /** Extra plain vars (installation id, operator settings). Secrets are merged later. */
  vars?: Record<string, string>;
  /** Guided credential login (scripts/selfhost/guided-login.ts); omit to run no container. */
  guidedLogin?: GuidedLoginSettings | null;
}

/** Name used for the per-database flat migration directories inside the project dir. */
export const MIGRATIONS_ROOT = 'd1-migrations';
export const ASSETS_BINDING = 'ASSETS';

type Rule =
  | { kind: 'drop'; reason: string }
  | { kind: 'translate'; apply: (value: unknown, ctx: TranslateContext) => void };

interface TranslateContext {
  out: Partial<CelldWranglerConfig>;
  plan: Omit<CelldConfigPlan, 'config'>;
  options: CelldConfigOptions;
}

function fail(message: string): never {
  throw new Error(`celld config: ${message}`);
}

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${context} must be a table`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) fail(`${context} must be an array`);
  return value;
}

function asString(value: unknown, context: string): string {
  if (typeof value !== 'string' || value.length === 0)
    fail(`${context} must be a non-empty string`);
  return value;
}

/** Copies exactly `fields` from a binding entry and throws on any other field. */
function pickFields<K extends string>(
  value: unknown,
  context: string,
  fields: readonly K[]
): Record<K, string> {
  const record = asRecord(value, context);
  const allowed = new Set<string>(fields);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail(`${context} has keys celld config does not translate: ${unknown.join(', ')}`);
  }
  const picked = {} as Record<K, string>;
  for (const key of fields) picked[key] = asString(record[key], `${context}.${key}`);
  return picked;
}

function stringArray(value: unknown, context: string): string[] {
  return asArray(value, context).map((entry, index) => asString(entry, `${context}[${index}]`));
}

/** `src/db/migrations` -> `d1-migrations/workspaces-dev`; flat, inside the project. */
function migrationDirName(databaseName: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(databaseName)) {
    fail(`D1 database_name "${databaseName}" is not a safe directory name`);
  }
  return `${MIGRATIONS_ROOT}/${databaseName}`;
}

function translateMigrations(value: unknown, ctx: TranslateContext): void {
  const entries = asArray(value, 'migrations') as MigrationEntry[];
  // A celld fleet is always a clean install from the Cloudflare migration history's point of
  // view: fold every legacy `new_classes` create into `new_sqlite_classes` with the shared
  // resolver the Cloudflare pipeline uses for clean installs.
  // An empty `new_classes: []` is a no-op the resolver leaves in place; drop it so it is not
  // mistaken for an untranslatable key below.
  const withoutEmpty = entries.map(({ new_classes, ...rest }) =>
    new_classes?.length ? { ...rest, new_classes } : rest
  );
  const resolved = resolveDurableObjectMigrations(withoutEmpty, null) ?? [];
  ctx.out.migrations = resolved.map((entry) => {
    const extra = Object.keys(entry).filter((key) => key !== 'tag' && key !== 'new_sqlite_classes');
    if (extra.length > 0) {
      fail(
        `migration ${entry.tag} uses ${extra.join(', ')}; celld accepts only tag + new_sqlite_classes`
      );
    }
    return {
      tag: asString(entry.tag, 'migrations[].tag'),
      new_sqlite_classes: stringArray(entry.new_sqlite_classes ?? [], `migrations ${entry.tag}`),
    };
  });
  const folded = entries.filter((entry) => entry.new_classes?.length).map((entry) => entry.tag);
  if (folded.length > 0) {
    ctx.plan.report.push(`fold new_classes into new_sqlite_classes: ${folded.join(', ')}`);
  }
}

function translateD1(value: unknown, ctx: TranslateContext): void {
  ctx.out.d1_databases = asArray(value, 'd1_databases').map((entry, index) => {
    const d = pickFields(entry, `d1_databases[${index}]`, [
      'binding',
      'database_name',
      'database_id',
      'migrations_dir',
    ]);
    const projectRelativeDir = migrationDirName(d.database_name);
    ctx.plan.migrationDirs.push({
      databaseName: d.database_name,
      projectRelativeDir,
      sourceDir: d.migrations_dir,
    });
    ctx.plan.report.push(
      `d1 ${d.binding}: migrations_dir ${d.migrations_dir} -> ${projectRelativeDir} (flat)`
    );
    return {
      binding: d.binding,
      database_name: d.database_name,
      database_id: d.database_id,
      migrations_dir: projectRelativeDir,
    };
  });
}

function translateR2(value: unknown, ctx: TranslateContext): void {
  // celld refuses two bindings that name one bucket. SAM binds R2 and
  // PROJECT_DATA_ARCHIVE_R2 to one Cloudflare bucket and separates them by key prefix,
  // so later duplicates get a name derived from their binding.
  const seen = new Set<string>();
  ctx.out.r2_buckets = asArray(value, 'r2_buckets').map((entry, index) => {
    const b = pickFields(entry, `r2_buckets[${index}]`, ['binding', 'bucket_name']);
    let bucketName = b.bucket_name;
    if (seen.has(bucketName)) {
      bucketName = `${bucketName}-${b.binding.toLowerCase().replaceAll('_', '-')}`;
      if (seen.has(bucketName)) fail(`r2 binding ${b.binding} cannot get a distinct bucket name`);
      ctx.plan.report.push(`r2 ${b.binding}: shared bucket ${b.bucket_name} -> ${bucketName}`);
    }
    seen.add(bucketName);
    return { binding: b.binding, bucket_name: bucketName };
  });
}

/**
 * Cloudflare Containers. With guided login on, only the sign-in sandbox class runs, under the
 * configured runtime; every other class (VmAgentContainer, Instant) stays a plain DO. The image
 * is built from the minimal context `materialiseSandboxImageContext` writes into the project.
 */
function translateContainers(value: unknown, ctx: TranslateContext): void {
  const guided = ctx.options.guidedLogin;
  const out: CelldContainer[] = [];
  for (const [index, raw] of asArray(value, 'containers').entries()) {
    const entry = asRecord(raw, `containers[${index}]`);
    const className = asString(entry.class_name, `containers[${index}].class_name`);
    if (!guided || className !== GUIDED_LOGIN_CONTAINER_CLASS) {
      ctx.plan.report.push(`drop container ${className}: stays bound as a plain DO`);
      continue;
    }
    const unknown = Object.keys(entry).filter(
      (key) => !['class_name', 'image', 'instance_type', 'max_instances'].includes(key)
    );
    if (unknown.length > 0)
      fail(`containers ${className} has untranslated keys: ${unknown.join(', ')}`);
    const container: CelldContainer = {
      class_name: className,
      image: `${SANDBOX_IMAGE_DIR}/Dockerfile`,
      instance_type: guided.instanceType,
    };
    if (typeof entry.max_instances === 'number') container.max_instances = entry.max_instances;
    if (guided.runtime) container.runtime = guided.runtime;
    out.push(container);
    ctx.plan.report.push(
      `container ${className}: runtime ${guided.runtime ?? 'daemon default'}, ` +
        `instance_type ${guided.instanceType} (wrangler.toml ${String(entry.instance_type)})`
    );
  }
  if (guided && out.length === 0)
    fail(`guided login needs a ${GUIDED_LOGIN_CONTAINER_CLASS} container`);
  if (out.length > 0) ctx.out.containers = out;
}

const RULES: Readonly<Record<string, Rule>> = {
  name: { kind: 'translate', apply: (v, ctx) => (ctx.out.name = asString(v, 'name')) },
  main: { kind: 'translate', apply: (_v, ctx) => (ctx.out.main = ctx.options.main) },
  compatibility_date: {
    kind: 'translate',
    apply: (v, ctx) => (ctx.out.compatibility_date = asString(v, 'compatibility_date')),
  },
  compatibility_flags: {
    kind: 'translate',
    apply: (v, ctx) => (ctx.out.compatibility_flags = stringArray(v, 'compatibility_flags')),
  },
  port: { kind: 'drop', reason: 'wrangler dev port; celld listens where the node is started' },
  limits: { kind: 'drop', reason: 'no celld equivalent (CELLD_HANDLER_BUDGET_S is node-wide)' },
  alias: { kind: 'drop', reason: "celld's own esbuild bundles apps/api without the shim" },
  vars: {
    kind: 'translate',
    apply: (v, ctx) => {
      const vars = asRecord(v, 'vars');
      ctx.out.vars = Object.fromEntries(
        Object.entries(vars).map(([key, value]) => {
          if (typeof value === 'object' && value !== null) fail(`vars.${key} must be a scalar`);
          return [key, String(value)];
        })
      );
    },
  },
  artifacts: { kind: 'drop', reason: 'Cloudflare Artifacts binding; ARTIFACTS_ENABLED=false' },
  analytics_engine_datasets: {
    kind: 'drop',
    reason: 'Analytics Engine binding; ANALYTICS_ENABLED=false',
  },
  ai: { kind: 'drop', reason: 'Workers AI binding' },
  containers: { kind: 'translate', apply: translateContainers },
  d1_databases: { kind: 'translate', apply: translateD1 },
  kv_namespaces: {
    kind: 'translate',
    apply: (v, ctx) =>
      (ctx.out.kv_namespaces = asArray(v, 'kv_namespaces').map((entry, index) => {
        const kv = pickFields(entry, `kv_namespaces[${index}]`, ['binding', 'id']);
        return { binding: kv.binding, id: kv.id };
      })),
  },
  r2_buckets: { kind: 'translate', apply: translateR2 },
  durable_objects: {
    kind: 'translate',
    apply: (v, ctx) => {
      const record = asRecord(v, 'durable_objects');
      const unknown = Object.keys(record).filter((key) => key !== 'bindings');
      if (unknown.length > 0) fail(`durable_objects has untranslated keys: ${unknown.join(', ')}`);
      ctx.out.durable_objects = {
        bindings: asArray(record.bindings, 'durable_objects.bindings').map((entry, index) => {
          const b = pickFields(entry, `durable_objects.bindings[${index}]`, ['name', 'class_name']);
          return { name: b.name, class_name: b.class_name };
        }),
      };
    },
  },
  migrations: { kind: 'translate', apply: translateMigrations },
  triggers: {
    kind: 'translate',
    apply: (v, ctx) => {
      const record = asRecord(v, 'triggers');
      const unknown = Object.keys(record).filter((key) => key !== 'crons');
      if (unknown.length > 0) fail(`triggers has untranslated keys: ${unknown.join(', ')}`);
      ctx.out.triggers = { crons: stringArray(record.crons ?? [], 'triggers.crons') };
    },
  },
};

const REQUIRED_OUTPUT_KEYS = [
  'name',
  'main',
  'compatibility_date',
  'vars',
  'd1_databases',
  'kv_namespaces',
  'r2_buckets',
  'durable_objects',
  'migrations',
  'triggers',
] as const;

/**
 * Builds the celld config for one deployment.
 *
 * Throws on any wrangler.toml key without a translation rule, on binding fields it does not
 * know, and on Durable Object migrations celld cannot apply (renames, deletes, transfers).
 */
export function buildCelldConfig(
  source: WranglerToml,
  options: CelldConfigOptions
): CelldConfigPlan {
  if (!/^[a-z0-9.-]+$/i.test(options.baseDomain) || !options.baseDomain.includes('.')) {
    fail(`baseDomain "${options.baseDomain}" is not a domain name`);
  }
  for (const key of GENERATED_VAR_KEYS) {
    if (options.vars && key in options.vars) fail(`vars.${key} is generated; do not pass it`);
  }

  const unknownKeys = Object.keys(source).filter((key) => !(key in RULES));
  if (unknownKeys.length > 0) {
    fail(
      `wrangler.toml has top-level keys with no self-host translation: ${unknownKeys.join(', ')}. ` +
        'Add a rule to scripts/selfhost/celld-config.ts (translate it, or drop it with a reason ' +
        'and make the Worker inert without it).'
    );
  }

  const ctx: TranslateContext = { out: {}, plan: { migrationDirs: [], report: [] }, options };
  for (const [key, value] of Object.entries(source)) {
    const rule = RULES[key];
    if (!rule) continue; // unreachable: unknown keys were rejected above
    if (rule.kind === 'drop') ctx.plan.report.push(`drop [${key}]: ${rule.reason}`);
    else rule.apply(value, ctx);
  }
  for (const key of REQUIRED_OUTPUT_KEYS) {
    if (ctx.out[key] === undefined) fail(`wrangler.toml is missing ${key}`);
  }

  const out = ctx.out as CelldWranglerConfig;
  out.compatibility_flags ??= [];
  const r2 = out.r2_buckets.find((bucket) => bucket.binding === 'R2');
  out.vars = {
    ...out.vars,
    ...SELFHOST_VAR_OVERRIDES,
    ...(options.vars ?? {}),
    ...(out.containers ? { SANDBOX_CONTAINER_RUNTIME_AVAILABLE: 'true' } : {}),
    BASE_DOMAIN: options.baseDomain,
    ...(r2 ? { R2_BUCKET_NAME: r2.bucket_name } : {}),
  };

  if (options.assetsDirectory !== undefined) {
    if (
      options.assetsDirectory.startsWith('/') ||
      options.assetsDirectory.split('/').includes('..')
    ) {
      fail('assetsDirectory must be relative to the project dir with no ..');
    }
    if (out.durable_objects.bindings.some((b) => b.name === ASSETS_BINDING)) {
      fail(`binding name ${ASSETS_BINDING} is already used`);
    }
    // run_worker_first: every request reaches the Worker, which sends only
    // app.${BASE_DOMAIN} to env.ASSETS (lib/pages-proxy.ts). Without it celld would answer
    // api./ws-* requests whose path matches a file in the web build.
    out.assets = {
      directory: options.assetsDirectory,
      binding: ASSETS_BINDING,
      not_found_handling: 'single-page-application',
      run_worker_first: true,
    };
  }

  return { config: out, migrationDirs: ctx.plan.migrationDirs, report: ctx.plan.report };
}
