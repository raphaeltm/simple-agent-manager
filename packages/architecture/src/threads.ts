import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { link, lstat, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import * as v from 'valibot';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import { compareCanonicalStrings } from './canonical-order';
import {
  ARCHITECTURE_SCHEMA_VERSION,
  DEFAULT_THREAD_AUTHOR,
  DEFAULT_THREAD_AUTHOR_LIMIT,
  DEFAULT_THREAD_BODY_LIMIT,
  DEFAULT_THREAD_LOCK_RETRY_MS,
  DEFAULT_THREAD_LOCK_TIMEOUT_MS,
  DEFAULT_THREAD_TITLE_LIMIT,
  DEFAULT_THREADS_DIR,
  THREAD_FILE_EXTENSION,
} from './constants';
import type { ArchitectureDiagnostic } from './diagnostics';
import { parseWorkspaceDocument } from './document';
import { PathSafetyError, resolveContainedPath } from './path-safety';
import {
  type ArchitectureThread,
  type ThreadMessage,
  type ThreadMessageMetadata,
  threadMessageMetadataSchema,
  threadMessageSchema,
  threadMetadataSchema,
  threadSchema,
} from './schemas';
import type { Located } from './types';

const MESSAGE_MARKER = '<!-- arch-message ';
const MESSAGE_MARKER_END = ' -->';
const RESERVED_MESSAGE_DELIMITER = '<!-- arch-message';

export interface ThreadWriteOptions {
  workspaceRoot: string;
  target: string;
  question: string;
  author?: string;
  now?: Date;
  id?: string;
  threadsDir?: string;
  limits?: Partial<ThreadContentLimits>;
}

export interface ReplyWriteOptions {
  workspaceRoot: string;
  threadId: string;
  body: string;
  author?: string;
  now?: Date;
  replyTo?: string;
  threadsDir?: string;
  limits?: Partial<ThreadContentLimits>;
  lock?: Partial<ThreadLockOptions>;
}

export interface ThreadContentLimits {
  authorChars: number;
  bodyChars: number;
  titleChars: number;
}

export interface ThreadLockOptions {
  retryMs: number;
  timeoutMs: number;
}

export const DEFAULT_THREAD_LOCK_OPTIONS: ThreadLockOptions = {
  retryMs: DEFAULT_THREAD_LOCK_RETRY_MS,
  timeoutMs: DEFAULT_THREAD_LOCK_TIMEOUT_MS,
};

export const DEFAULT_THREAD_CONTENT_LIMITS: ThreadContentLimits = {
  authorChars: DEFAULT_THREAD_AUTHOR_LIMIT,
  bodyChars: DEFAULT_THREAD_BODY_LIMIT,
  titleChars: DEFAULT_THREAD_TITLE_LIMIT,
};

/** Load and validate all thread artifacts under the configured directory. */
export async function loadThreads(
  workspaceRoot: string,
  threadsDir = DEFAULT_THREADS_DIR
): Promise<{ threads: Located<ArchitectureThread>[]; diagnostics: ArchitectureDiagnostic[] }> {
  const diagnostics: ArchitectureDiagnostic[] = [];
  const threads: Located<ArchitectureThread>[] = [];
  const root = await resolveContainedPath({
    root: workspaceRoot,
    relativePath: threadsDir,
    mustExist: false,
  });
  const files = await collectThreadFiles(root, workspaceRoot);
  for (const file of files) {
    try {
      const thread = await parseThreadFile(file);
      threads.push({
        value: thread,
        location: { file: path.relative(workspaceRoot, file), documentPath: 'thread' },
      });
    } catch (error) {
      diagnostics.push({
        severity: 'error',
        code: 'thread-invalid',
        file: path.relative(workspaceRoot, file),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { threads, diagnostics };
}

/** Atomically create a confined, validated thread file. */
export async function createThread(options: ThreadWriteOptions): Promise<ArchitectureThread> {
  validateThreadContent(options);
  const now = (options.now ?? new Date()).toISOString();
  const threadId = options.id ?? `thread-${randomUUID()}`;
  assertSafeIdentifier(threadId, 'thread id');
  const message = makeMessage({
    body: options.question,
    author: options.author,
    now,
    seed: `${threadId}-initial`,
  });
  const thread: ArchitectureThread = {
    version: ARCHITECTURE_SCHEMA_VERSION,
    id: threadId,
    target: options.target,
    title: titleFromQuestion(options.question),
    status: 'unresolved',
    createdAt: now,
    updatedAt: now,
    messages: [message],
  };
  assertValidThread(thread);
  const relativeThreadPath = path.posix.join(
    options.threadsDir ?? DEFAULT_THREADS_DIR,
    `${threadId}${THREAD_FILE_EXTENSION}`
  );
  const absoluteThreadPath = await resolveContainedPath({
    root: options.workspaceRoot,
    relativePath: relativeThreadPath,
    mustExist: false,
  });
  await mkdir(path.dirname(absoluteThreadPath), { recursive: true });
  await atomicWriteNewFile(absoluteThreadPath, serializeThread(thread));
  return thread;
}

/** Append a confined, validated reply to an existing thread file. */
export async function appendThreadReply(options: ReplyWriteOptions): Promise<ThreadMessage> {
  validateReplyContent(options);
  assertSafeIdentifier(options.threadId, 'thread id');
  const relativeThreadPath = path.posix.join(
    options.threadsDir ?? DEFAULT_THREADS_DIR,
    `${options.threadId}${THREAD_FILE_EXTENSION}`
  );
  const absoluteThreadPath = await resolveContainedPath({
    root: options.workspaceRoot,
    relativePath: relativeThreadPath,
    mustExist: true,
  });
  return withThreadLock(absoluteThreadPath, options.lock, async () => {
    const existing = await parseThreadFile(absoluteThreadPath);
    if (options.replyTo && !existing.messages.some((message) => message.id === options.replyTo)) {
      throw new Error(
        `Reply target was not found in thread ${options.threadId}: ${options.replyTo}`
      );
    }
    const now = (options.now ?? new Date()).toISOString();
    const message = makeMessage({
      body: options.body,
      author: options.author,
      now,
      replyTo: options.replyTo,
      id: `msg-${randomUUID()}`,
    });
    assertValidMessage(message);
    const handle = await open(
      absoluteThreadPath,
      fsConstants.O_APPEND | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW
    );
    try {
      const stats = await handle.stat();
      if (!stats.isFile())
        throw new Error(`Thread path is not a regular file: ${options.threadId}`);
      await handle.appendFile(`\n${serializeMessage(message)}`);
    } finally {
      await handle.close();
    }
    return message;
  });
}

/** Parse and validate one thread Markdown file. */
export async function parseThreadFile(filePath: string): Promise<ArchitectureThread> {
  const parsed = await parseWorkspaceDocument(filePath);
  const metadataResult = v.safeParse(threadMetadataSchema, parsed.data);
  if (!metadataResult.success)
    throw new Error(metadataResult.issues.map((issue) => issue.message).join('; '));
  const messages = parseMessages(parsed.body ?? (await readFile(filePath, 'utf8')));
  const updatedAt = messages.reduce(
    (latest, message) =>
      compareCanonicalStrings(message.createdAt, latest) > 0 ? message.createdAt : latest,
    metadataResult.output.updatedAt
  );
  return { ...metadataResult.output, updatedAt, messages };
}

function parseMessages(body: string): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  const messageIds = new Set<string>();
  const parts = body.split(MESSAGE_MARKER);
  for (const part of parts.slice(1)) {
    const markerEnd = part.indexOf(MESSAGE_MARKER_END);
    if (markerEnd === -1)
      throw new Error('Thread message marker is missing its closing delimiter.');
    const metadataRaw = part.slice(0, markerEnd);
    const bodyStart = markerEnd + MESSAGE_MARKER_END.length;
    const nextMarker = part.indexOf(MESSAGE_MARKER, bodyStart);
    const messageBody = (
      nextMarker === -1 ? part.slice(bodyStart) : part.slice(bodyStart, nextMarker)
    ).trim();
    const metadata = parseMessageMetadata(metadataRaw);
    const message = { ...metadata, body: messageBody };
    assertValidMessage(message);
    if (messageIds.has(message.id)) throw new Error(`Duplicate thread message id: ${message.id}`);
    messageIds.add(message.id);
    messages.push(message);
  }
  for (const message of messages) {
    if (message.replyTo && !messageIds.has(message.replyTo)) {
      throw new Error(`Thread reply target was not found: ${message.replyTo}`);
    }
  }
  return messages;
}

function parseMessageMetadata(raw: string): ThreadMessageMetadata {
  try {
    const parsed = parseYaml(raw) as unknown;
    const parsedResult = v.safeParse(threadMessageMetadataSchema, parsed);
    if (parsedResult.success) return parsedResult.output;
    throw new Error(parsedResult.issues.map((issue) => issue.message).join('; '));
  } catch (error) {
    throw new Error(
      `Invalid thread message metadata: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function serializeThread(thread: ArchitectureThread): string {
  const { messages, ...metadata } = thread;
  const frontmatter = stringifyYaml(metadata).trimEnd();
  const serializedMessages = messages.map(serializeMessage).join('\n');
  return `---\n${frontmatter}\n---\n${serializedMessages}\n`;
}

function serializeMessage(message: ThreadMessage): string {
  const { body, ...metadata } = message;
  const marker = `${MESSAGE_MARKER}${stringifyYaml(metadata).trim()}${MESSAGE_MARKER_END}`;
  return `${marker}\n${body.trim()}\n`;
}

function makeMessage(input: {
  body: string;
  author?: string;
  now: string;
  replyTo?: string;
  id?: string;
  seed?: string;
}): ThreadMessage {
  return {
    id: input.id ?? makeStableId('msg', input.seed ?? randomUUID()),
    author: (input.author ?? DEFAULT_THREAD_AUTHOR).trim(),
    body: input.body.trim(),
    createdAt: input.now,
    replyTo: input.replyTo,
  };
}

function makeStableId(prefix: string, seed: string): string {
  let hash = 2166136261;
  for (const char of seed) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

async function atomicWriteNewFile(filePath: string, content: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tempPath, content, { flag: 'wx' });
  try {
    await link(tempPath, filePath);
  } finally {
    await unlink(tempPath);
  }
}

function assertValidThread(thread: ArchitectureThread): void {
  const result = v.safeParse(threadSchema, thread);
  if (!result.success) throw new Error(result.issues.map((issue) => issue.message).join('; '));
}

function assertValidMessage(message: ThreadMessage): void {
  const result = v.safeParse(threadMessageSchema, message);
  if (!result.success) throw new Error(result.issues.map((issue) => issue.message).join('; '));
}

function assertSafeIdentifier(value: string, label: string): void {
  if (/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(value)) return;
  throw new PathSafetyError(`Invalid ${label}: ${value}`);
}

function validateThreadContent(options: ThreadWriteOptions): void {
  const limits = { ...DEFAULT_THREAD_CONTENT_LIMITS, ...options.limits };
  assertContentLength(options.question, limits.bodyChars, 'thread question');
  assertNoReservedMessageDelimiter(options.question, 'thread question');
  const author = options.author ?? DEFAULT_THREAD_AUTHOR;
  assertContentLength(author, limits.authorChars, 'thread author');
  assertNoReservedMessageSyntax(author, 'thread author');
}

function titleFromQuestion(question: string): string {
  const compact = question.trim().replace(/\s+/g, ' ');
  return compact.length <= DEFAULT_THREAD_TITLE_LIMIT
    ? compact
    : `${compact.slice(0, Math.max(0, DEFAULT_THREAD_TITLE_LIMIT - 1)).trimEnd()}…`;
}

function validateReplyContent(options: ReplyWriteOptions): void {
  const limits = { ...DEFAULT_THREAD_CONTENT_LIMITS, ...options.limits };
  assertContentLength(options.body, limits.bodyChars, 'reply body');
  assertNoReservedMessageDelimiter(options.body, 'reply body');
  const author = options.author ?? DEFAULT_THREAD_AUTHOR;
  assertContentLength(author, limits.authorChars, 'reply author');
  assertNoReservedMessageSyntax(author, 'reply author');
}

function assertNoReservedMessageDelimiter(value: string, label: string): void {
  if (!value.includes(RESERVED_MESSAGE_DELIMITER)) return;
  throw new PathSafetyError(
    `${label} must not contain the reserved architecture message delimiter.`
  );
}

function assertNoReservedMessageSyntax(value: string, label: string): void {
  if (!value.includes(RESERVED_MESSAGE_DELIMITER) && !value.includes('-->')) return;
  throw new PathSafetyError(`${label} must not contain reserved architecture message syntax.`);
}

function assertContentLength(value: string, limit: number, label: string): void {
  if (value.trim().length > 0 && value.length <= limit) return;
  throw new Error(`${label} must contain between 1 and ${limit} characters.`);
}

async function withThreadLock<T>(
  threadPath: string,
  overrides: Partial<ThreadLockOptions> | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const options = { ...DEFAULT_THREAD_LOCK_OPTIONS, ...overrides };
  const lockPath = path.join(path.dirname(threadPath), `.${path.basename(threadPath)}.lock`);
  const deadline = Date.now() + options.timeoutMs;
  let lockHandle: Awaited<ReturnType<typeof open>>;
  let lockInode: bigint;
  while (true) {
    try {
      lockHandle = await open(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600
      );
      try {
        await lockHandle.writeFile(`${process.pid}:${randomUUID()}\n`);
        lockInode = (await lockHandle.stat({ bigint: true })).ino;
      } catch (error) {
        await lockHandle.close();
        await unlink(lockPath).catch(() => undefined);
        throw error;
      }
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for thread mutation lock: ${path.basename(threadPath)}. ` +
            `If no architecture process is running, remove ${path.basename(lockPath)} manually.`
        );
      }
      await delay(options.retryMs);
    }
  }
  try {
    return await operation();
  } finally {
    await lockHandle.close();
    await releaseOwnedLock(lockPath, lockInode);
  }
}

async function releaseOwnedLock(lockPath: string, expectedInode: bigint): Promise<void> {
  try {
    const lockStats = await lstat(lockPath, { bigint: true });
    if (!lockStats.isFile() || lockStats.ino !== expectedInode) {
      throw new Error(`Thread mutation lock ownership changed: ${path.basename(lockPath)}`);
    }
    await unlink(lockPath);
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function collectThreadFiles(root: string, workspaceRoot: string): Promise<string[]> {
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const relative = path.posix.join(
        path.relative(workspaceRoot, root).replaceAll(path.sep, '/'),
        entry.name
      );
      const absolute = await resolveContainedPath({
        root: workspaceRoot,
        relativePath: relative,
        mustExist: true,
      });
      if (entry.isDirectory()) files.push(...(await collectThreadFiles(absolute, workspaceRoot)));
      if (entry.isFile() && entry.name.endsWith(THREAD_FILE_EXTENSION)) files.push(absolute);
    }
    return files.sort(compareCanonicalStrings);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return [];
    throw error;
  }
}
