/** Shared deployment orchestration. Runner owns source checkout, Docker/toolchains,
 * durable installation lock and private checkpoint transport. Hooks are trusted
 * installation configuration, never browser-supplied commands. Child output is
 * captured privately and never included in events or exceptions.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { renameSync, writeFileSync } from 'node:fs';

// @ts-expect-error Existing shared JavaScript validators have no declaration file.
import * as resourceNames from './workflow-resource-names.mjs';
const { stackNameForEnvironment, validateBaseDomain, validateResourcePrefix, validateBucketName } =
  resourceNames;

export interface EngineCommand {
  executable: string;
  args: string[];
}
interface EngineConfigBase {
  schemaVersion: 1;
  sourceCommit: string;
  accountId: string;
  zoneId: string;
  zoneName: string;
  baseDomain: string;
  environment: string;
  prefix?: string;
  codexBuild: EngineCommand;
  codexPublish: EngineCommand;
  commandTimeoutMs?: number;
  healthAttempts?: number;
  healthIntervalMs?: number;
  cloudflareApiUrl?: string;
}
export type InstallerEngineConfig = EngineConfigBase &
  (
    | {
        profile?: 'installation';
        ownerEmail: string;
        workersDev: { action: 'create' | 'preserve'; subdomain: string };
        dryRun?: never;
        skipAgent?: never;
        stateBucket?: never;
      }
    | {
        profile: 'legacy-ci';
        ownerEmail?: never;
        dryRun?: boolean;
        skipAgent?: boolean;
        stateBucket?: string;
      }
  );
export interface EngineEvent {
  phase: string;
  status: 'started' | 'completed' | 'failed';
  operation?: string;
  exitCode?: number | null;
  signal?: string | null;
}
export interface EngineCheckpoint {
  schemaVersion: 1;
  fingerprint: string;
  completed: string[];
  activePhase?: string;
  status: 'running' | 'failed' | 'completed';
}
export interface EngineRunner {
  run(
    command: EngineCommand,
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; includeStderr?: boolean }
  ): Promise<string>;
  request(url: string, init?: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<void>;
}
export interface EngineResult {
  sourceCommit: string;
  appUrl: string;
  setupToken: string;
}
export interface EngineArtifact {
  kind: 'vm-agent-container';
  version: string;
  buildDate: string;
  sha256: string;
}
export interface EngineOptions {
  root: string;
  environment: NodeJS.ProcessEnv;
  checkpoint?: EngineCheckpoint;
  save(checkpoint: EngineCheckpoint): void | Promise<void>;
  emit(event: EngineEvent): void;
  reportArtifact?(artifact: EngineArtifact): void | Promise<void>;
  saveResult?(result: EngineResult): void | Promise<void>;
  runner?: EngineRunner;
}
export const DEFAULT_COMMAND_TIMEOUT_MS = 60 * 60 * 1000;
export const DEFAULT_HEALTH_ATTEMPTS = 30;
export const DEFAULT_HEALTH_INTERVAL_MS = 10_000;
export const DEFAULT_CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4';
const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

function validateLegacyCiSettings(c: InstallerEngineConfig): void {
  if (
    c.profile === 'legacy-ci' &&
    (c.ownerEmail !== undefined ||
      (c.dryRun !== undefined && typeof c.dryRun !== 'boolean') ||
      (c.skipAgent !== undefined && typeof c.skipAgent !== 'boolean'))
  )
    throw new Error('Invalid legacy CI settings');
}

function validateRunnerProfile(c: InstallerEngineConfig): void {
  if (c.profile !== undefined && c.profile !== 'installation' && c.profile !== 'legacy-ci')
    throw new Error('Unsupported runner profile');
  if (
    c.profile !== 'legacy-ci' &&
    (typeof c.ownerEmail !== 'string' ||
      c.ownerEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.ownerEmail))
  )
    throw new Error('Approved ownerEmail is required');
  if (c.profile !== 'legacy-ci' && ('dryRun' in c || 'skipAgent' in c || 'stateBucket' in c))
    throw new Error('Legacy CI options cannot change installation safety');
  validateLegacyCiSettings(c);
  if (
    c.profile !== 'legacy-ci' &&
    (!c.workersDev ||
      !['create', 'preserve'].includes(c.workersDev.action) ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(c.workersDev.subdomain))
  )
    throw new Error('Approved workers.dev target is required');
}

function validateExecutionSettings(c: InstallerEngineConfig): void {
  for (const key of ['codexBuild', 'codexPublish'] as const) {
    const command = c[key];
    if (
      !command ||
      typeof command.executable !== 'string' ||
      !command.executable ||
      !Array.isArray(command.args) ||
      command.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))
    ) {
      throw new Error(`${key} source-build adapter is required`);
    }
  }
  for (const key of ['commandTimeoutMs', 'healthAttempts', 'healthIntervalMs'] as const) {
    if (
      c[key] !== undefined &&
      (typeof c[key] !== 'number' || !Number.isSafeInteger(c[key]) || c[key] <= 0)
    )
      throw new Error(`Invalid ${key}`);
  }
}

export function validateEngineConfig(input: unknown): InstallerEngineConfig {
  if (!input || typeof input !== 'object')
    throw new Error('Installation configuration is required');
  const c = input as InstallerEngineConfig;
  validateRunnerProfile(c);
  if (c.schemaVersion !== 1) throw new Error('Unsupported installation configuration version');
  if (!/^[0-9a-f]{40}$/.test(c.sourceCommit))
    throw new Error('sourceCommit must be an immutable commit');
  for (const key of ['accountId', 'zoneId'] as const) {
    if (!/^[0-9a-f]{32}$/.test(c[key])) throw new Error(`${key} must be a Cloudflare identifier`);
  }
  validateBaseDomain(c.baseDomain);
  validateBaseDomain(c.zoneName);
  if (c.baseDomain !== c.zoneName && !c.baseDomain.endsWith(`.${c.zoneName}`)) {
    throw new Error('Installation domain must belong to selected zone');
  }
  const stack = stackNameForEnvironment(c.environment);
  const prefix =
    c.prefix ?? `s${createHash('sha256').update(c.baseDomain).digest('hex').slice(0, 6)}`;
  validateResourcePrefix(prefix);
  validateBucketName(c.stateBucket ?? `${prefix}-pulumi-state-${c.environment}`);
  validateBucketName(`${prefix}-${stack}-assets`);
  validateExecutionSettings(c);
  const api = new URL(c.cloudflareApiUrl ?? DEFAULT_CLOUDFLARE_API_URL);
  if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash)
    throw new Error('Invalid Cloudflare API URL');
  return { ...c, prefix };
}
export function engineFingerprint(config: InstallerEngineConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex');
}
export class EngineCommandFailure extends Error {
  constructor(
    public readonly exitCode: number | null,
    public readonly signal: string | null
  ) {
    super('Deployment command failed');
  }
}

export const processRunner: EngineRunner = {
  async run(command, options) {
    return new Promise((accept, reject) => {
      const maxCaptureBytes = Number(
        options.env.INSTALLER_ENGINE_CAPTURE_MAX_BYTES ?? MAX_CAPTURE_BYTES
      );
      if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes <= 0) {
        reject(new Error('Invalid output capture limit'));
        return;
      }
      let output = '';
      let size = 0;
      let failed = false;
      const child = spawn(command.executable, command.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeoutMs,
        killSignal: 'SIGKILL',
      });
      const collect = (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxCaptureBytes) {
          failed = true;
          child.kill('SIGKILL');
        } else output += chunk.toString();
      };
      child.stdout.on('data', collect);
      // Drain stderr, but do not return or expose it: tools may print credentials.
      child.stderr.on('data', options.includeStderr ? collect : () => {});
      child.once('error', () => reject(new Error('Deployment command could not start')));
      child.once('close', (code, signal) =>
        code === 0 && !failed ? accept(output) : reject(new EngineCommandFailure(code, signal))
      );
    });
  },
  request: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((accept) => setTimeout(accept, ms)),
};

/** Persist on a private filesystem; adapter uploads this non-secret state durably. */
export function writeEngineCheckpoint(path: string, checkpoint: EngineCheckpoint): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(checkpoint), { mode: 0o600 });
  renameSync(temporary, path);
}

export { stackNameForEnvironment };

export function assertWorkerDeployDiagnostics(output: string, artifactsEnabled: boolean): void {
  if (!output.includes('not inherited by environments')) return;
  const warnings = output
    .split('\n')
    .filter((line) => /- "[^"]+" exists at the top level/.test(line));
  if (
    !artifactsEnabled &&
    warnings.length > 0 &&
    warnings.every((line) => line.includes('"artifacts" exists at the top level'))
  )
    return;
  throw new Error('Worker binding inheritance validation failed');
}

export function parseEngineCheckpoint(value: unknown): EngineCheckpoint {
  if (!value || typeof value !== 'object') throw new Error('Invalid checkpoint');
  const state = value as Partial<EngineCheckpoint>;
  if (
    state.schemaVersion !== 1 ||
    typeof state.fingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(state.fingerprint) ||
    !Array.isArray(state.completed) ||
    state.completed.some((entry) => typeof entry !== 'string') ||
    !['running', 'failed', 'completed'].includes(String(state.status)) ||
    (state.activePhase !== undefined && typeof state.activePhase !== 'string')
  )
    throw new Error('Invalid checkpoint');
  return state as EngineCheckpoint;
}
