/**
 * Binary model inputs and outputs travel through the calling agent's workspace, never through
 * the agent's own context: an LLM cannot usefully emit or read megabytes of base64.
 *
 * - Input: any `{ "$file": "<relative path>", "encoding"?: "base64" | "bytes" | "data-url" }`
 *   object inside `input` is replaced by that workspace file's contents.
 * - Output: binary responses, base64 media inside JSON, and JSON too large to return inline are
 *   written into the workspace and replaced by `{ "$savedFile": { path, contentType, sizeBytes } }`.
 */
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import {
  downloadFromWorkspace,
  resolveWorkspaceVmUrl,
  uploadToWorkspace,
  validateRelativePath,
} from '../workspace-file-transfer';
import { AgentModelCallError } from './errors';

/** Workspace directory for saved outputs when the agent does not name one. */
export const DEFAULT_AGENT_MODEL_OUTPUT_DIR = '.ai-outputs';
/** A JSON string this long that is pure base64 is saved as a file even if its type is unknown. */
const UNKNOWN_BASE64_SAVE_MIN_CHARS = 64 * 1024;
/** Shortest base64 string checked for a known media signature. */
const MEDIA_BASE64_MIN_CHARS = 1_024;
const BASE64_ONLY = /^[A-Za-z0-9+/]+={0,2}$/;
/** Characters of a saved oversized JSON output echoed back inline. */
const OUTPUT_PREVIEW_CHARS = 2_000;

type FileEncoding = 'base64' | 'bytes' | 'data-url';

export interface WorkspaceFiles {
  read(path: string, maxBytes: number): Promise<{ data: ArrayBuffer; contentType: string }>;
  write(directory: string, filename: string, data: ArrayBuffer): Promise<string>;
}

/** File access to the calling workspace, resolving the VM agent URL once on first use. */
export function workspaceFiles(
  env: Env,
  ctx: { projectId: string; userId: string; workspaceId: string | null }
): WorkspaceFiles {
  let target: Promise<{ vmBaseUrl: string; nodeId: string; workspaceId: string }> | null = null;
  const resolve = () => {
    target ??= (async () => {
      if (!ctx.workspaceId) {
        throw new AgentModelCallError(
          'workspace_required',
          'Reading or saving files needs a running workspace.'
        );
      }
      const result = await resolveWorkspaceVmUrl(
        drizzle(env.DATABASE, { schema }),
        env,
        ctx.workspaceId,
        ctx.projectId
      );
      if ('error' in result) throw new AgentModelCallError('workspace_required', result.error);
      return { ...result, workspaceId: ctx.workspaceId };
    })();
    return target;
  };
  return {
    async read(path, maxBytes) {
      const { vmBaseUrl, nodeId, workspaceId } = await resolve();
      return downloadFromWorkspace(env, vmBaseUrl, nodeId, workspaceId, ctx.userId, path, maxBytes);
    },
    async write(directory, filename, data) {
      const { vmBaseUrl, nodeId, workspaceId } = await resolve();
      await uploadToWorkspace({
        env,
        vmBaseUrl,
        nodeId,
        workspaceId,
        userId: ctx.userId,
        filename,
        data,
        targetPath: directory,
      });
      return `${directory}/${filename}`;
    },
  };
}

export function bytesToBase64(data: ArrayBuffer | Uint8Array): string {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let binary = '';
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function fileReference(value: unknown): { path: string; encoding: FileEncoding } | null {
  const record = maybeJsonRecord(value);
  if (!record || typeof record.$file !== 'string') return null;
  const encoding = record.encoding ?? 'base64';
  if (encoding !== 'base64' && encoding !== 'bytes' && encoding !== 'data-url') {
    throw new AgentModelCallError(
      'invalid_input',
      `Unsupported $file encoding "${String(encoding)}". Use "base64", "bytes" or "data-url".`
    );
  }
  const path = record.$file.trim();
  const pathError = path ? validateRelativePath(path) : 'Path is empty';
  if (pathError)
    throw new AgentModelCallError('invalid_input', `Invalid $file path "${path}": ${pathError}`);
  return { path, encoding };
}

/** Replace every `$file` reference with the file's contents in the requested encoding. */
export async function resolveFileReferences(
  input: Record<string, unknown>,
  files: WorkspaceFiles,
  limits: { maxTotalBytes: number; maxFileReferences: number }
): Promise<{ input: Record<string, unknown>; fileCount: number }> {
  const { maxTotalBytes, maxFileReferences } = limits;
  let fileCount = 0;
  let totalBytes = 0;
  const visit = async (value: unknown): Promise<unknown> => {
    const reference = fileReference(value);
    if (reference) {
      fileCount += 1;
      if (fileCount > maxFileReferences) {
        throw new AgentModelCallError(
          'invalid_input',
          maxFileReferences === 0
            ? 'File inputs ($file) are turned off by your SAM administrator.'
            : `At most ${maxFileReferences} $file references per call.`
        );
      }
      const remaining = maxTotalBytes - totalBytes;
      if (remaining <= 0) {
        throw new AgentModelCallError(
          'input_too_large',
          `Files in this call exceed ${maxTotalBytes} bytes.`
        );
      }
      const { data, contentType } = await files.read(reference.path, remaining);
      totalBytes += data.byteLength;
      if (totalBytes > maxTotalBytes) {
        throw new AgentModelCallError(
          'input_too_large',
          `Files in this call exceed ${maxTotalBytes} bytes.`
        );
      }
      if (reference.encoding === 'bytes') return Array.from(new Uint8Array(data));
      const base64 = bytesToBase64(data);
      if (reference.encoding === 'data-url') {
        return `data:${contentType.split(';')[0] || 'application/octet-stream'};base64,${base64}`;
      }
      return base64;
    }
    // Files are read one at a time, never in parallel: each read is handed only the budget the
    // previous reads left, so many sibling references cannot together pull more than the cap
    // into the Worker.
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) items.push(await visit(item));
      return items;
    }
    const record = maybeJsonRecord(value);
    if (!record) return value;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) result[key] = await visit(child);
    return result;
  };
  const resolved = maybeJsonRecord(await visit(input)) ?? {};
  return { input: resolved, fileCount };
}

const SIGNATURES: ReadonlyArray<{ bytes: number[]; offset?: number; type: string; ext: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], type: 'image/png', ext: 'png' },
  { bytes: [0xff, 0xd8, 0xff], type: 'image/jpeg', ext: 'jpg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], type: 'image/gif', ext: 'gif' },
  { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8, type: 'image/webp', ext: 'webp' },
  { bytes: [0x57, 0x41, 0x56, 0x45], offset: 8, type: 'audio/wav', ext: 'wav' },
  { bytes: [0x49, 0x44, 0x33], type: 'audio/mpeg', ext: 'mp3' },
  { bytes: [0xff, 0xfb], type: 'audio/mpeg', ext: 'mp3' },
  { bytes: [0x4f, 0x67, 0x67, 0x53], type: 'audio/ogg', ext: 'ogg' },
  { bytes: [0x66, 0x4c, 0x61, 0x43], type: 'audio/flac', ext: 'flac' },
  { bytes: [0x66, 0x74, 0x79, 0x70], offset: 4, type: 'video/mp4', ext: 'mp4' },
];

function sniff(bytes: Uint8Array): { type: string; ext: string } | null {
  for (const signature of SIGNATURES) {
    const offset = signature.offset ?? 0;
    if (signature.bytes.every((byte, index) => bytes[offset + index] === byte)) {
      return { type: signature.type, ext: signature.ext };
    }
  }
  return null;
}

const EXTENSION_BY_TYPE: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'video/mp4': 'mp4',
  'application/json': 'json',
  'text/plain': 'txt',
};

export interface SavedFile {
  path: string;
  contentType: string;
  sizeBytes: number;
}

export interface OutputSaver {
  save(data: ArrayBuffer | Uint8Array, contentType: string, hint: string): Promise<SavedFile>;
  saved: SavedFile[];
}

export function outputSaver(
  files: WorkspaceFiles,
  directory: string,
  modelName: string,
  now: Date
): OutputSaver {
  // 2026-10-23T00:18:47.123Z -> 20261023T001847
  const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, '');
  const saved: SavedFile[] = [];
  return {
    saved,
    async save(data, contentType, hint) {
      const type = contentType.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
      const ext = EXTENSION_BY_TYPE[type] ?? 'bin';
      // Split and rejoin rather than trim with a regex: linear on any hint length.
      const safeHint = hint
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .split('-')
        .filter(Boolean)
        .join('-')
        .slice(0, 40);
      const filename = `${modelName}-${stamp}${safeHint ? `-${safeHint}` : ''}-${saved.length + 1}.${ext}`;
      const buffer = data instanceof Uint8Array ? data.slice().buffer : data;
      const path = await files.write(directory, filename, buffer);
      const file = { path, contentType: type, sizeBytes: buffer.byteLength };
      saved.push(file);
      return file;
    },
  };
}

/** Replace base64 media strings in a JSON output with saved workspace files. */
export async function extractBase64Media(
  value: unknown,
  saver: OutputSaver,
  key = ''
): Promise<unknown> {
  if (typeof value === 'string') {
    if (value.length < MEDIA_BASE64_MIN_CHARS || !BASE64_ONLY.test(value)) return value;
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(value);
    } catch {
      return value;
    }
    const media = sniff(bytes);
    if (!media && value.length < UNKNOWN_BASE64_SAVE_MIN_CHARS) return value;
    return { $savedFile: await saver.save(bytes, media?.type ?? 'application/octet-stream', key) };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = [];
    for (const item of value) items.push(await extractBase64Media(item, saver, key));
    return items;
  }
  const record = maybeJsonRecord(value);
  if (!record) return value;
  const result: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(record)) {
    result[childKey] = await extractBase64Media(child, saver, childKey);
  }
  return result;
}

/** Keep JSON output inline when it fits; otherwise save it and return a preview. */
export async function inlineOrSaveJson(
  value: unknown,
  saver: OutputSaver,
  maxInlineBytes: number
): Promise<{ output: unknown; truncated: boolean }> {
  const serialized = JSON.stringify(value);
  if (new TextEncoder().encode(serialized).byteLength <= maxInlineBytes) {
    return { output: value, truncated: false };
  }
  const file = await saver.save(
    new TextEncoder().encode(JSON.stringify(value, null, 2)),
    'application/json',
    'output'
  );
  return {
    output: { $savedFile: file, preview: serialized.slice(0, OUTPUT_PREVIEW_CHARS) },
    truncated: true,
  };
}
