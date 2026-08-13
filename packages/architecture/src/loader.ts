import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { compareCanonicalStrings } from './canonical-order';
import { compileWorkspace } from './compiler';
import { DEFAULT_THREADS_DIR, DEFAULT_WORKSPACE_DIR, THREAD_FILE_EXTENSION } from './constants';
import type { ArchitectureDiagnostic } from './diagnostics';
import { loadThreads } from './threads';
import type { LoadedWorkspace, LoadWorkspaceOptions } from './types';

const WORKSPACE_FILE_EXTENSIONS = ['.yaml', '.yml', '.md'] as const;

/** Compile one filesystem workspace into its canonical graph and indexes. */
export async function loadArchitectureWorkspace(
  options: LoadWorkspaceOptions = {}
): Promise<LoadedWorkspace> {
  const workspaceRoot = await realpath(
    path.resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_DIR)
  );
  const repoRoot = await realpath(path.resolve(options.repoRoot ?? process.cwd()));
  const files = await collectWorkspaceFiles(workspaceRoot, workspaceRoot);
  const modelFiles = files.filter((file) => {
    const relative = path.relative(workspaceRoot, file).replaceAll(path.sep, '/');
    return !relative.endsWith(THREAD_FILE_EXTENSION);
  });
  const manifestPass = await compileWorkspace({
    workspaceRoot,
    repoRoot,
    files: modelFiles,
    threads: [],
  });
  const threadsDir = manifestPass.workspace.manifest.threadsDir ?? DEFAULT_THREADS_DIR;
  const threadLoad = await loadThreads(workspaceRoot, threadsDir);
  const compiled = await compileWorkspace({
    workspaceRoot,
    repoRoot,
    files: modelFiles,
    threads: threadLoad.threads,
  });
  const diagnostics: ArchitectureDiagnostic[] = [
    ...threadLoad.diagnostics,
    ...compiled.diagnostics,
  ];
  return { workspace: compiled.workspace, diagnostics };
}

/** Validate a workspace and return all deterministic compiler diagnostics. */
export async function validateArchitectureWorkspace(
  options: LoadWorkspaceOptions = {}
): Promise<ArchitectureDiagnostic[]> {
  return (await loadArchitectureWorkspace(options)).diagnostics;
}

async function collectWorkspaceFiles(root: string, workspaceRoot: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) =>
    compareCanonicalStrings(left.name, right.name)
  )) {
    if (entry.name.startsWith('.')) continue;
    const absolute = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      files.push(...(await collectWorkspaceFiles(absolute, workspaceRoot)));
      continue;
    }
    if (entry.isFile() && isWorkspaceFile(entry.name)) files.push(absolute);
  }
  return files
    .map((file) => path.relative(workspaceRoot, file).replaceAll(path.sep, '/'))
    .sort(compareCanonicalStrings)
    .map((relative) => path.join(workspaceRoot, relative));
}

function isWorkspaceFile(fileName: string): boolean {
  return WORKSPACE_FILE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}
