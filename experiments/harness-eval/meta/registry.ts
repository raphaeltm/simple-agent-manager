/**
 * Candidate registry — tracks harness candidate versions with metadata.
 *
 * Persists to a JSON file at experiments/harness-eval/meta/candidates.json.
 * Provides CRUD operations for managing candidates and querying version history.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { HarnessCandidate, CandidateEntry, CandidateMetadata } from './candidate.js';

const REGISTRY_PATH = join(dirname(new URL(import.meta.url).pathname), 'candidates.json');

/** In-memory registry state. */
interface RegistryData {
  /** Schema version for forward compatibility */
  version: '1.0';
  /** All registered candidates, keyed by versionId */
  candidates: Record<string, CandidateEntry>;
}

function ensureDir(filepath: string): void {
  const dir = dirname(filepath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Load the registry from disk. Returns an empty registry if the file doesn't exist. */
export function loadRegistry(): RegistryData {
  if (!existsSync(REGISTRY_PATH)) {
    return { version: '1.0', candidates: {} };
  }
  const raw = readFileSync(REGISTRY_PATH, 'utf-8');
  return JSON.parse(raw) as RegistryData;
}

/** Save the registry to disk. */
export function saveRegistry(data: RegistryData): void {
  ensureDir(REGISTRY_PATH);
  writeFileSync(REGISTRY_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

/** Register a new candidate. Throws if versionId already exists. */
export function registerCandidate(
  candidate: HarnessCandidate,
  metadata: CandidateMetadata = { tags: [] },
): CandidateEntry {
  const data = loadRegistry();
  if (data.candidates[candidate.versionId]) {
    throw new Error(`Candidate "${candidate.versionId}" already exists in the registry`);
  }
  const entry: CandidateEntry = { candidate, metadata };
  data.candidates[candidate.versionId] = entry;
  saveRegistry(data);
  return entry;
}

/** Get a candidate by version ID. Returns undefined if not found. */
export function getCandidate(versionId: string): CandidateEntry | undefined {
  const data = loadRegistry();
  return data.candidates[versionId];
}

/** List all registered candidates, sorted by createdAt descending. */
export function listCandidates(): CandidateEntry[] {
  const data = loadRegistry();
  return Object.values(data.candidates).sort(
    (a, b) => new Date(b.candidate.createdAt).getTime() - new Date(a.candidate.createdAt).getTime(),
  );
}

/** List candidates matching a tag filter. */
export function listByTag(tag: string): CandidateEntry[] {
  return listCandidates().filter((e) => e.metadata.tags.includes(tag));
}

/** Get the version lineage for a candidate (walk parentVersionId chain). */
export function getLineage(versionId: string): HarnessCandidate[] {
  const data = loadRegistry();
  const lineage: HarnessCandidate[] = [];
  let currentId: string | undefined = versionId;

  while (currentId) {
    const entry = data.candidates[currentId];
    if (!entry) break;
    lineage.push(entry.candidate);
    currentId = entry.candidate.parentVersionId;
  }

  return lineage;
}
