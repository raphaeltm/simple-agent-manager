import { readFile } from 'node:fs/promises';

import { DEFAULT_MAX_SOURCE_BYTES, DEFAULT_SOURCE_CONTEXT_LINES } from './constants';
import { resolveContainedPath } from './path-safety';
import type { SourceRef } from './schemas';
import type { CompiledWorkspace, SourceReadOptions, SourceReadResult } from './types';

export async function readSourceReference(
  workspace: CompiledWorkspace,
  sourceRef: SourceRef,
  options: SourceReadOptions = {}
): Promise<SourceReadResult> {
  const absolutePath = await resolveContainedPath({
    root: workspace.repoRoot,
    relativePath: sourceRef.path,
    mustExist: true,
  });
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  const raw = await readFile(absolutePath, 'utf8');
  const truncated = Buffer.byteLength(raw, 'utf8') > maxBytes;
  const content = truncated ? raw.slice(0, maxBytes) : raw;
  const lines = content.split(/\r?\n/);
  const context = options.contextLines ?? DEFAULT_SOURCE_CONTEXT_LINES;
  const requestedStart = sourceRef.startLine ?? 1;
  const requestedEnd = sourceRef.endLine ?? requestedStart;
  const startLine = Math.max(1, requestedStart - context);
  const endLine = Math.min(lines.length, requestedEnd + context);
  return {
    path: sourceRef.path,
    startLine,
    endLine,
    content: lines.slice(startLine - 1, endLine).join('\n'),
    truncated,
  };
}
