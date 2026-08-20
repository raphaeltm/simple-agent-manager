import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';

import { DEFAULT_MAX_SOURCE_BYTES, DEFAULT_SOURCE_CONTEXT_LINES } from './constants';
import { resolveContainedPath } from './path-safety';
import type { SourceRef } from './schemas';
import type {
  CompiledWorkspace,
  SourceReadGroup,
  SourceReadOptions,
  SourceReadResult,
} from './types';

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
  if (options.fullFile) {
    const snippet = await readLineWindow(absolutePath, 1, Number.MAX_SAFE_INTEGER, maxBytes);
    return {
      path: sourceRef.path,
      startLine: 1,
      endLine: snippet.endLine,
      content: snippet.content,
      truncated: snippet.truncated,
      contextLines: context,
    };
  }
  if (sourceRef.lineGroups && sourceRef.lineGroups.length > 0) {
    const groups: SourceReadGroup[] = [];
    let usedBytes = 0;
    for (const group of sourceRef.lineGroups) {
      const startLine = Math.max(1, group.startLine - context);
      const requestedEnd = group.endLine + context;
      const remainingBytes = maxBytes - usedBytes;
      if (remainingBytes <= 0) {
        groups.push({
          startLine,
          endLine: startLine - 1,
          requestedStartLine: group.startLine,
          requestedEndLine: group.endLine,
          ...(group.label ? { label: group.label } : {}),
          content: '',
          truncated: true,
        });
        continue;
      }
      const snippet = await readLineWindow(absolutePath, startLine, requestedEnd, remainingBytes);
      usedBytes += Buffer.byteLength(snippet.content, 'utf8');
      groups.push({
        startLine,
        endLine: snippet.endLine,
        requestedStartLine: group.startLine,
        requestedEndLine: group.endLine,
        ...(group.label ? { label: group.label } : {}),
        content: snippet.content,
        truncated: snippet.truncated,
      });
    }
    const first = groups[0];
    const last = groups.at(-1);
    return {
      path: sourceRef.path,
      startLine: first?.startLine ?? 1,
      endLine: last?.endLine ?? 1,
      content: groups
        .map((group) => `L${group.startLine}–${group.endLine}\n${group.content}`)
        .join('\n\n'),
      truncated: groups.some((group) => group.truncated),
      contextLines: context,
      groups,
    };
  }
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
    contextLines: context,
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
