/**
 * Custom HTTP headers for bring-your-own MCP servers.
 *
 * Rules this module owns, for both the write path (`mcp-connections.ts`) and the injection
 * path (`mcp-connection-resolution.ts`):
 *  - Names use the mcp-remote / TOML-bare-key charset, are unique case-insensitively, and may
 *    not be headers the MCP transport sets itself.
 *  - `Authorization` would collide with a bearer token, so it is only accepted when the
 *    connection's `authType` is `none` (a non-Bearer scheme).
 *  - Values are secrets. The whole `[{name, value}]` list is sealed as one AES-GCM ciphertext
 *    and is never returned; `header_names` is the plaintext display projection written beside it.
 *
 * Error messages name a header by its name only, never by its value.
 */
import {
  MCP_CONNECTION_HEADER_NAME_PATTERN,
  MCP_CONNECTION_HEADER_NAME_RULE,
  MCP_CONNECTION_RESERVED_HEADER_NAMES,
  type McpConnectionAuthType,
  type McpConnectionHeader,
  type McpConnectionHeaderUpdate,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type * as schema from '../db/schema';
import { log } from '../lib/logger';
import { utf8ByteLength } from '../lib/utf8';
import { errors } from '../middleware/error';
import { decrypt, encrypt } from './encryption';

export interface McpConnectionHeaderLimits {
  maxHeaders: number;
  headerValueMaxBytes: number;
}

/** The three header columns. They are only ever written together. */
export interface SealedMcpConnectionHeaders {
  headerNames: string;
  encryptedHeaders: string | null;
  headersIv: string | null;
}

type HeaderColumns = Pick<schema.McpConnectionRow, 'encryptedHeaders' | 'headersIv'>;

/** Tab, CR, LF, NUL and the rest: anything that could split a header or a config line. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

const StoredHeadersSchema = v.array(v.object({ name: v.string(), value: v.string() }));
const HeaderNamesSchema = v.array(v.string());

/**
 * Validates the complete header set a connection will store, and trims names and values.
 *
 * `authType` is the connection's effective auth type after the write, because an
 * `Authorization` header is only legal without a bearer token.
 */
export function validateMcpConnectionHeaders(
  headers: readonly McpConnectionHeader[],
  authType: McpConnectionAuthType,
  limits: McpConnectionHeaderLimits
): McpConnectionHeader[] {
  if (headers.length > limits.maxHeaders) {
    throw errors.badRequest(`Maximum ${limits.maxHeaders} headers per MCP server`);
  }

  const seen = new Set<string>();
  return headers.map((header) => {
    const name = header.name.trim();
    if (!MCP_CONNECTION_HEADER_NAME_PATTERN.test(name)) {
      throw errors.badRequest(`Invalid header name ${JSON.stringify(name)}: ${MCP_CONNECTION_HEADER_NAME_RULE}`);
    }

    const key = name.toLowerCase();
    if (MCP_CONNECTION_RESERVED_HEADER_NAMES.includes(key)) {
      throw errors.badRequest(`Header "${name}" is set by the MCP transport and cannot be overridden`);
    }
    if (key === 'authorization' && authType === 'bearer') {
      throw errors.badRequest(
        'An Authorization header conflicts with the bearer token; set authentication to "none" to send your own'
      );
    }
    if (seen.has(key)) {
      throw errors.badRequest(`Header "${name}" is set more than once`);
    }
    seen.add(key);

    const value = header.value.trim();
    if (!value) {
      throw errors.badRequest(`Header "${name}" needs a value`);
    }
    if (utf8ByteLength(value) > limits.headerValueMaxBytes) {
      throw errors.badRequest(`Header "${name}" value exceeds max size of ${limits.headerValueMaxBytes} bytes`);
    }
    if (CONTROL_CHARACTERS.test(value)) {
      throw errors.badRequest(`Header "${name}" value must not contain line breaks or control characters`);
    }
    return { name, value };
  });
}

/**
 * Resolves an update's desired header set against the stored one.
 *
 * An entry without a `value` keeps the value stored under that name (case-insensitive), so a
 * client can add, remove or rotate a single header without ever holding the others' secrets.
 * Naming a header that is not stored, without a value, is a 400 — there is nothing to keep.
 */
export function applyMcpConnectionHeaderUpdate(
  stored: readonly McpConnectionHeader[],
  desired: readonly McpConnectionHeaderUpdate[]
): McpConnectionHeader[] {
  const storedValues = new Map(stored.map((header) => [header.name.toLowerCase(), header.value]));
  return desired.map(({ name, value }) => {
    if (value !== undefined) {
      return { name, value };
    }
    const kept = storedValues.get(name.trim().toLowerCase());
    if (kept === undefined) {
      throw errors.badRequest(`Header "${name.trim()}" needs a value`);
    }
    return { name, value: kept };
  });
}

/** Seals a validated header set into its columns. An empty set clears all three. */
export async function sealMcpConnectionHeaders(
  headers: readonly McpConnectionHeader[],
  encryptionKey: string
): Promise<SealedMcpConnectionHeaders> {
  if (headers.length === 0) {
    return { headerNames: '[]', encryptedHeaders: null, headersIv: null };
  }
  const sealed = await encrypt(JSON.stringify(headers), encryptionKey);
  return {
    headerNames: JSON.stringify(headers.map((header) => header.name)),
    encryptedHeaders: sealed.ciphertext,
    headersIv: sealed.iv,
  };
}

/**
 * Decrypts a row's header set.
 *
 * Throws when the ciphertext is unreadable or would not be accepted by the vm-agent, which
 * rejects a whole create-agent-session request over one malformed header. The injection path
 * catches per row, so a bad row is skipped rather than breaking session start (rules 41/50).
 */
export async function openMcpConnectionHeaders(
  row: HeaderColumns,
  encryptionKey: string
): Promise<McpConnectionHeader[]> {
  if (!row.encryptedHeaders && !row.headersIv) {
    return [];
  }
  if (!row.encryptedHeaders || !row.headersIv) {
    throw new Error('stored headers are missing their ciphertext or IV');
  }

  // The plaintext holds secret values, so neither a JSON syntax error (V8 quotes the input) nor
  // a Valibot issue (it quotes the offending value) may reach a log or response — both are
  // replaced with fixed messages (rule 51).
  const plaintext = await decrypt(row.encryptedHeaders, row.headersIv, encryptionKey);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error('stored headers are not valid JSON');
  }
  const result = v.safeParse(StoredHeadersSchema, parsed);
  if (!result.success) {
    throw new Error('stored headers are not a list of name/value pairs');
  }
  const headers = result.output;
  for (const [index, header] of headers.entries()) {
    if (!MCP_CONNECTION_HEADER_NAME_PATTERN.test(header.name)) {
      throw new Error(`stored header ${index} has an invalid name`);
    }
    if (!header.value || CONTROL_CHARACTERS.test(header.value)) {
      throw new Error(`stored header ${index} has an empty or unsafe value`);
    }
  }
  return headers;
}

/**
 * Display projection for API responses. A malformed column reads as "no names" and is logged,
 * rather than failing the whole list the row appears in (rule 50). The injection path never
 * reads this column.
 */
export function readMcpConnectionHeaderNames(
  row: Pick<schema.McpConnectionRow, 'id' | 'headerNames'>
): string[] {
  try {
    return v.parse(HeaderNamesSchema, JSON.parse(row.headerNames));
  } catch (error) {
    log.warn('mcp_connections.header_names_unreadable', {
      connectionId: row.id,
      error: error instanceof Error ? error.message : String(error),
      action: 'shown_without_header_names',
    });
    return [];
  }
}
