/**
 * The durable record of one legacy adoption (legacy-adoption.ts): private, fsynced and atomically
 * replaced after every step, so a killed run resumes exactly where it stopped. The original .env
 * bytes are kept beside it until the adoption either completes or is rolled back.
 */
import { existsSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { assertPrivateFile, replacePrivateFile } from './secret-files';

export const ADOPTION_JOURNAL_FILE = 'legacy-adoption.json';
/** A private copy of the operator's .env from before COMPOSE_PROJECT_NAME was written. */
export const ADOPTION_ENV_FILE = 'legacy-adoption.env';

/**
 * proving: ownership proved, backup not yet recorded complete. backed-up: encrypted snapshot
 * taken. stopped: legacy stack stopped. switched: canonical volumes copied and .env names the
 * canonical project. adopted: canonical stack healthy and receipts written; only the upgrade
 * remains. Each phase implies all earlier ones.
 */
export const ADOPTION_PHASES = ['proving', 'backed-up', 'stopped', 'switched', 'adopted'] as const;
export type AdoptionPhase = (typeof ADOPTION_PHASES)[number];

export interface AdoptionVolume {
  suffix: string;
  legacy: string;
  canonical: string;
  /** CreatedAt of the canonical volume this adoption made; set before any copy into it. */
  createdAt?: string;
  /** Verified digest once the copy is complete. */
  digest?: string;
}

export interface AdoptionJournal {
  version: 1;
  /** Random; labels every canonical volume this adoption creates. */
  adoptionId: string;
  from: string;
  to: string;
  legacyProject: string;
  canonicalProject: string;
  installationId: string;
  phase: AdoptionPhase;
  backupDir?: string;
  /** The legacy containers proved before the stop; removed only after verified adoption. */
  legacyContainers: string[];
  volumes: AdoptionVolume[];
  /** Set before the canonical stack is first started: its celld may have written the bucket. */
  canonicalStarted: boolean;
  /** Set before `compose stop`: a kill after the stop must not look like an untouched stack. */
  stopRequested?: boolean;
  /** Set before rollback starts: a killed rollback resumes as a rollback, never forward. */
  rollingBack?: boolean;
  /** Set while the chained upgrade's completed marker is still durable (upgrade-journal.ts). */
  upgraded?: boolean;
}

const SHA = /^[a-f0-9]{40}$/;
const CONTAINER = /^[a-f0-9]{64}$/;

const invalid = (path: string): never => {
  throw new Error(
    `${path} is not a legacy adoption record this tool wrote; preserve it and the stack for inspection`
  );
};

export function phaseAtLeast(journal: AdoptionJournal, phase: AdoptionPhase): boolean {
  return ADOPTION_PHASES.indexOf(journal.phase) >= ADOPTION_PHASES.indexOf(phase);
}

const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
const SUFFIX = /^[a-z0-9][a-z0-9_.-]*$/;

function validVolume(value: unknown, legacyProject: string, canonicalProject: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.suffix === 'string' &&
    SUFFIX.test(v.suffix) &&
    v.legacy === `${legacyProject}_${v.suffix}` &&
    v.canonical === `${canonicalProject}_${v.suffix}` &&
    (v.createdAt === undefined || typeof v.createdAt === 'string') &&
    (v.digest === undefined || (typeof v.digest === 'string' && /^[a-f0-9]{64}$/.test(v.digest)))
  );
}

export function readAdoptionJournal(stateDir: string): AdoptionJournal | null {
  const path = join(stateDir, ADOPTION_JOURNAL_FILE);
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return invalid(path);
  assertPrivateFile(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return invalid(path);
  }
  const j = raw as Record<string, unknown>;
  if (
    !raw ||
    typeof raw !== 'object' ||
    j.version !== 1 ||
    typeof j.adoptionId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(j.adoptionId) ||
    typeof j.from !== 'string' ||
    !SHA.test(j.from) ||
    typeof j.to !== 'string' ||
    !SHA.test(j.to) ||
    typeof j.legacyProject !== 'string' ||
    !PROJECT.test(j.legacyProject) ||
    typeof j.canonicalProject !== 'string' ||
    !/^sam-selfhost-[a-f0-9]{12}$/.test(j.canonicalProject) ||
    j.legacyProject === j.canonicalProject ||
    typeof j.installationId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(j.installationId) ||
    !ADOPTION_PHASES.includes(j.phase as AdoptionPhase) ||
    (j.backupDir !== undefined && (typeof j.backupDir !== 'string' || !isAbsolute(j.backupDir))) ||
    !Array.isArray(j.legacyContainers) ||
    !j.legacyContainers.every((id) => typeof id === 'string' && CONTAINER.test(id)) ||
    !Array.isArray(j.volumes) ||
    !j.volumes.every((v) =>
      validVolume(v, j.legacyProject as string, j.canonicalProject as string)
    ) ||
    typeof j.canonicalStarted !== 'boolean' ||
    !['stopRequested', 'rollingBack', 'upgraded'].every(
      (key) => j[key] === undefined || typeof j[key] === 'boolean'
    )
  )
    return invalid(path);
  return raw as AdoptionJournal;
}

export function writeAdoptionJournal(stateDir: string, journal: AdoptionJournal): void {
  replacePrivateFile(
    join(stateDir, ADOPTION_JOURNAL_FILE),
    `${JSON.stringify(journal, null, 2)}\n`
  );
}

/** Keeps the operator's original .env once; a resumed run never overwrites the first copy. */
export function saveOriginalEnv(stateDir: string, envFile: string): void {
  const path = join(stateDir, ADOPTION_ENV_FILE);
  if (existsSync(path)) {
    assertPrivateFile(path);
    return;
  }
  assertPrivateFile(envFile);
  replacePrivateFile(path, readFileSync(envFile, 'utf8'));
}

export function readOriginalEnv(stateDir: string): string {
  const path = join(stateDir, ADOPTION_ENV_FILE);
  assertPrivateFile(path);
  return readFileSync(path, 'utf8');
}

export function clearAdoptionJournal(stateDir: string): void {
  rmSync(join(stateDir, ADOPTION_ENV_FILE), { force: true });
  rmSync(join(stateDir, ADOPTION_JOURNAL_FILE), { force: true });
}

/** .env with COMPOSE_PROJECT_NAME set to `project`, every other byte preserved. */
export function envWithProject(original: string, project: string): string {
  const lines = original.split('\n');
  const kept = lines.filter((line) => !/^\s*(export\s+)?COMPOSE_PROJECT_NAME\s*=/.test(line));
  const body = kept.join('\n');
  const sep = body === '' || body.endsWith('\n') ? '' : '\n';
  return `${body}${sep}COMPOSE_PROJECT_NAME=${project}\n`;
}
