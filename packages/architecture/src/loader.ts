import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { compileWorkspace } from './compiler';
import { DEFAULT_THREADS_DIR, DEFAULT_WORKSPACE_DIR } from './constants';
import type { ArchitectureDiagnostic } from './diagnostics';
import { loadThreads } from './threads';
import type { LoadedWorkspace, LoadWorkspaceOptions } from './types';

const WORKSPACE_FILE_EXTENSIONS = ['.yaml', '.yml', '.md'] as const;

export async function loadArchitectureWorkspace(
  options: LoadWorkspaceOptions = {}
): Promise<LoadedWorkspace> {
  const workspaceRoot = await realpath(
    path.resolve(options.workspaceRoot ?? DEFAULT_WORKSPACE_DIR)
  );
  const repoRoot = await realpath(path.resolve(options.repoRoot ?? process.cwd()));
  const files = await collectWorkspaceFiles(workspaceRoot, workspaceRoot);
  const threadLoad = await loadThreads(workspaceRoot, DEFAULT_THREADS_DIR);
  const threadsDirPrefix = `${DEFAULT_THREADS_DIR}/`;
  const modelFiles = files.filter((file) => {
    const relative = path.relative(workspaceRoot, file).replaceAll(path.sep, '/');
    return !relative.startsWith(threadsDirPrefix);
  });
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

export async function validateArchitectureWorkspace(
  options: LoadWorkspaceOptions = {}
): Promise<ArchitectureDiagnostic[]> {
  return (await loadArchitectureWorkspace(options)).diagnostics;
}

async function collectWorkspaceFiles(root: string, workspaceRoot: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
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
    .sort()
    .map((relative) => path.join(workspaceRoot, relative));
}

function isWorkspaceFile(fileName: string): boolean {
  return WORKSPACE_FILE_EXTENSIONS.some((extension) => fileName.endsWith(extension));
}
