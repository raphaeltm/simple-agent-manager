import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';

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
  const context = options.contextLines ?? DEFAULT_SOURCE_CONTEXT_LINES;
  const requestedStart = sourceRef.startLine ?? 1;
  const requestedEnd = sourceRef.endLine ?? requestedStart;
  const startLine = Math.max(1, requestedStart - context);
  const requestedContextEnd = requestedEnd + context;
  const snippet = await readLineWindow(absolutePath, startLine, requestedContextEnd, maxBytes);
  return {
    path: sourceRef.path,
    startLine,
    endLine: snippet.endLine,
    content: snippet.content,
    truncated: snippet.truncated,
  };
}

async function readLineWindow(
  absolutePath: string,
  startLine: number,
  requestedEndLine: number,
  maxBytes: number
): Promise<{ content: string; endLine: number; truncated: boolean }> {
  const lines: string[] = [];
  let usedBytes = 0;
  let lineNumber = 0;
  let endLine = startLine - 1;
  let truncated = false;
  const input = createReadStream(absolutePath, { encoding: 'utf8' });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lineNumber += 1;
      if (lineNumber < startLine) continue;
      if (lineNumber > requestedEndLine) break;
      const prefixBytes = lines.length === 0 ? 0 : Buffer.byteLength('\n', 'utf8');
      const availableBytes = maxBytes - usedBytes - prefixBytes;
      if (availableBytes <= 0) {
        truncated = true;
        break;
      }
      const lineBytes = Buffer.byteLength(line, 'utf8');
      lines.push(lineBytes <= availableBytes ? line : truncateUtf8(line, availableBytes));
      usedBytes += prefixBytes + Math.min(lineBytes, availableBytes);
      endLine = lineNumber;
      if (lineBytes > availableBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    reader.close();
    input.destroy();
  }
  return {
    content: lines.join('\n'),
    endLine,
    truncated,
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.byteLength <= maxBytes) return value;
  for (let end = maxBytes; end >= 0; end -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      // Backtrack until the byte slice ends at a valid UTF-8 boundary.
    }
  }
  return '';
}
