import { readFile } from 'node:fs/promises';

import { parse as parseYaml } from 'yaml';

import type { ArchitectureDiagnostic } from './diagnostics';

export interface ParsedDocument {
  data: unknown;
  body?: string;
}

export async function parseWorkspaceDocument(filePath: string): Promise<ParsedDocument> {
  const raw = await readFile(filePath, 'utf8');
  if (filePath.endsWith('.md')) return parseMarkdownDocument(raw);
  return { data: parseYaml(raw) };
}

function parseMarkdownDocument(raw: string): ParsedDocument {
  if (!raw.startsWith('---\n')) return { data: undefined, body: raw };
  const end = raw.indexOf('\n---', 4);
  if (end === -1) return { data: undefined, body: raw };
  const yaml = raw.slice(4, end);
  const body = raw.slice(end + '\n---'.length).replace(/^\n/, '');
  return { data: parseYaml(yaml), body };
}

export function diagnosticFromError(error: unknown, file: string): ArchitectureDiagnostic {
  return {
    severity: 'error',
    code: 'parse-error',
    file,
    message: error instanceof Error ? error.message : String(error),
  };
}
