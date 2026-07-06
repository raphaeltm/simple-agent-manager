import type { ToolCallItem } from '@simple-agent-manager/acp-client';

/**
 * Library tool names (base form, separator-agnostic — see normalizeToolName)
 * that render as a DocumentCard.
 *
 * Keep in sync with rawCaptureToolNames in
 * packages/vm-agent/internal/acp/message_extract.go.
 */
export const DOCUMENT_CARD_TOOLS = new Set([
  'upload_to_library',
  'replace_library_file',
  'display_from_library',
]);

/**
 * Namespace separators used by different agent adapters to prefix a tool
 * identifier: Claude uses `mcp__<server>__<tool>` (double underscore), Codex
 * uses `<server>/<tool>` (slash), others may use `.` or `:`. Single `_` is NOT
 * a separator (it is common inside tool names, e.g. `display_from_library`).
 */
const TOOL_NAME_SEPARATORS = /__|\/|\.|:/;

/**
 * Normalize a raw tool identifier to its base tool name, independent of the
 * agent's namespace-separator convention. Splits on any known separator
 * (`__`, `/`, `.`, `:`) and returns the last non-empty segment (the tool name),
 * or the input unchanged when there is no separator.
 *
 * Delimiter-agnostic on purpose: matching a specific prefix (`mcp__`) is
 * user-agent sniffing — every new adapter forces a new special case. Splitting
 * on the separator set handles `mcp__sam-mcp__display_from_library`,
 * `sam-mcp/display_from_library`, `sam-mcp-1/display_from_library`,
 * `sam-mcp.display_from_library`, and bare `display_from_library` with no new
 * code, and future adapters for free.
 */
export function normalizeToolName(toolName: string | undefined): string | undefined {
  if (!toolName) return undefined;
  const segments = toolName.split(TOOL_NAME_SEPARATORS).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : toolName;
}

/** Render state for a DocumentCard, chosen from the tool call's status + payload. */
export type DocumentCardState = 'ready' | 'pending' | 'tombstone' | 'unavailable';

export interface DocumentCardData {
  /** Base tool name (e.g. 'display_from_library'). */
  tool: string;
  state: DocumentCardState;
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  caption?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Extract the tool result payload from rawOutput. The claude ACP adapter sets
 * rawOutput to the MCP content array `[{ type: 'text', text: '<json>' }]`; we
 * also tolerate a bare object or a JSON string for robustness across adapters.
 */
function parseResultPayload(rawOutput: unknown): Record<string, unknown> | null {
  if (Array.isArray(rawOutput)) {
    for (const block of rawOutput) {
      if (
        isRecord(block)
        && (block.type === 'text' || block.type === 'content')
        && typeof block.text === 'string'
      ) {
        try {
          const parsed: unknown = JSON.parse(block.text);
          if (isRecord(parsed)) return parsed;
        } catch {
          // Not JSON — skip this block.
        }
      }
    }
    return null;
  }
  if (typeof rawOutput === 'string') {
    try {
      const parsed: unknown = JSON.parse(rawOutput);
      return isRecord(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return isRecord(rawOutput) ? rawOutput : null;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split('/');
  return parts[parts.length - 1] || undefined;
}

/**
 * Derive everything a DocumentCard needs from a tool-call item's toolName,
 * rawInput (the call args) and rawOutput (the MCP result). Pure and defensive:
 * every field is optional and the state degrades gracefully.
 *
 * - `upload_to_library` / `replace_library_file`: fileId + metadata come from
 *   the result payload (rawOutput). A FILE_EXISTS error carries `existingFile`,
 *   which we surface as the document.
 * - `display_from_library`: fileId comes from the args (rawInput) and metadata
 *   from the result; caption comes from the args.
 * - FILE_NOT_FOUND → tombstone. No fileId yet + still running → pending.
 */
export function extractDocumentCardData(item: ToolCallItem): DocumentCardData {
  const tool = normalizeToolName(item.toolName ?? item.title) ?? 'document';
  const input = isRecord(item.rawInput) ? item.rawInput : {};
  const result = parseResultPayload(item.rawOutput ?? item.content);

  const error = result ? str(result.error) : undefined;
  const existingFile = result && isRecord(result.existingFile) ? result.existingFile : undefined;

  // FILE_EXISTS surfaces the pre-existing file as the document to show.
  const source = existingFile ?? result ?? {};

  const fileId = str(source.id) ?? str(source.fileId) ?? str(input.fileId);
  const fileName =
    str(source.filename) ?? basename(str(input.filePath));
  const mimeType = str(source.mimeType);
  const sizeBytes = num(source.sizeBytes);
  const caption = str(input.caption) ?? (result ? str(result.caption) : undefined);

  let state: DocumentCardState;
  if (error === 'FILE_NOT_FOUND') {
    state = 'tombstone';
  } else if (fileId) {
    state = 'ready';
  } else if (item.status === 'pending' || item.status === 'in_progress') {
    state = 'pending';
  } else {
    state = 'unavailable';
  }

  return { tool, state, fileId, fileName, mimeType, sizeBytes, caption };
}
