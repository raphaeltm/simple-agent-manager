import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface ResolveContainedPathOptions {
  root: string;
  relativePath: string;
  mustExist?: boolean;
}

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathSafetyError';
  }
}

export function normalizeRepoRelativePath(input: string): string {
  if (input.trim() === '') throw new PathSafetyError('Path must not be empty.');
  if (path.isAbsolute(input)) throw new PathSafetyError(`Absolute paths are not allowed: ${input}`);
  if (input.includes('\0')) throw new PathSafetyError('Paths must not contain null bytes.');

  const normalized = input.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new PathSafetyError(`Path traversal is not allowed: ${input}`);
  }

  const posixNormalized = path.posix.normalize(normalized);
  if (posixNormalized === '.' || posixNormalized.startsWith('../')) {
    throw new PathSafetyError(`Path traversal is not allowed: ${input}`);
  }
  return posixNormalized;
}

export async function resolveContainedPath({
  root,
  relativePath,
  mustExist = true,
}: ResolveContainedPathOptions): Promise<string> {
  const safeRelativePath = normalizeRepoRelativePath(relativePath);
  const realRoot = await realpath(root);
  const candidate = path.resolve(realRoot, safeRelativePath);
  ensurePathInsideRoot(realRoot, candidate, relativePath);

  if (!mustExist) {
    await ensureExistingParentInsideRoot(realRoot, candidate);
    return candidate;
  }

  const realCandidate = await realpath(candidate);
  ensurePathInsideRoot(realRoot, realCandidate, relativePath);
  return realCandidate;
}

export function ensurePathInsideRoot(
  root: string,
  candidate: string,
  originalPath = candidate
): void {
  const relative = path.relative(root, candidate);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) return;
  throw new PathSafetyError(`Path escapes the allowed root: ${originalPath}`);
}

async function ensureExistingParentInsideRoot(realRoot: string, candidate: string): Promise<void> {
  let parent = path.dirname(candidate);
  while (parent !== path.dirname(parent)) {
    try {
      await lstat(parent);
      const realParent = await realpath(parent);
      ensurePathInsideRoot(realRoot, realParent, candidate);
      return;
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      parent = path.dirname(parent);
    }
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
