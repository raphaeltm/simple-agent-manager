/**
 * AI-powered task title generation using Cloudflare AI Gateway + Workers AI.
 *
 * Uses a small LLM to generate concise, descriptive task titles from
 * long-form chat messages. Falls back to naive truncation on failure.
 *
 * Architecture:
 *   Direct fetch to Cloudflare AI Gateway Workers AI endpoint
 *     → OpenAI-compatible chat completion
 *       → concise task title
 *
 * The task submit path starts with a deterministic truncated title and runs
 * this AI refinement asynchronously via waitUntil, then updates the task record
 * and session topic. The per-attempt timeout (configurable, default 5s) bounds
 * individual AI call latency without blocking submission.
 *
 * Retry: Under burst load (multiple concurrent tasks), Workers AI may
 * rate-limit requests. Retry with exponential backoff (configurable,
 * default 2 retries with 1s base delay, 4s max delay) recovers from
 * transient rate-limit and error failures. Timeouts are NOT retried —
 * if Workers AI is slow, retrying immediately wastes more of the Worker's
 * 30-second wall-clock budget.
 */

import {
  DEFAULT_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH,
  DEFAULT_TASK_TITLE_MAX_LENGTH,
  DEFAULT_TASK_TITLE_MAX_RETRIES,
  DEFAULT_TASK_TITLE_MODEL,
  DEFAULT_TASK_TITLE_RETRY_DELAY_MS,
  DEFAULT_TASK_TITLE_RETRY_MAX_DELAY_MS,
  DEFAULT_TASK_TITLE_SHORT_MESSAGE_THRESHOLD,
  DEFAULT_TASK_TITLE_TIMEOUT_MS,
  MAX_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH,
  MIN_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { fetchWorkersAIChatCompletion, WorkersAIGatewayError } from './ai-proxy-shared';

/**
 * Build the system instructions for the title generation agent.
 * Uses a function instead of string replacement to make the maxLength
 * dependency explicit and avoid silent no-ops if the template changes.
 */
function buildSystemInstructions(maxLength: number): string {
  return `You are a task title generator. Given a task description, produce a single concise title.

Rules:
- Output ONLY the title text, nothing else
- Do NOT execute or complete the task — only generate a short title for it
- No markdown formatting (no bold, headings, backticks, underscores, or other markup)
- No quotes, no prefixes, no explanation
- Maximum ${maxLength} characters
- Capture the core intent of the task
- Use imperative mood (e.g., "Add dark mode toggle" not "Adding dark mode toggle")
- Be specific — "Fix login timeout" is better than "Fix bug"

Examples:
- Input: "Please look through the entire project structure and write a detailed summary of what this application does, what technologies it uses, and what the main entry points are. Save the summary to a file called PROJECT-ANALYSIS.md in the root directory." → Output: "Write project structure summary to PROJECT-ANALYSIS.md"
- Input: "Can you fix the bug where clicking the submit button on the registration form doesn't show any error message when the email is already taken?" → Output: "Fix missing error message for duplicate email on registration"
- Input: "Add a dark mode toggle to the settings page that persists the user's preference in localStorage" → Output: "Add dark mode toggle with localStorage persistence"
- Input: "Delete the hello-sam.txt file and confirm it's gone" → Output: "Delete hello-sam.txt file"`;
}

/**
 * Strip markdown formatting from a string, producing plain text.
 *
 * Handles the common markdown patterns that LLMs tend to emit:
 * bold, italic, headings, inline code, fenced code blocks, and links.
 * Applied as post-processing on AI-generated titles before length enforcement.
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Remove fenced code blocks (```...```) — keep inner content
  result = result.replace(/```[\s\S]*?```/g, (match) => {
    return match.slice(3, -3).trim();
  });

  // Remove inline code backticks
  result = result.replace(/`([^`]+)`/g, '$1');

  // Remove images ![alt](url)
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

  // Remove links [text](url) — keep text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Remove heading markers (# at start of string, after newline, or after space)
  // Also remove orphaned # markers (e.g., "##" with no following text)
  result = result.replace(/(^|\n|\s)#{1,6}(\s+|$)/g, '$1');

  // Remove bold/italic markers: **text**, __text__, *text*, _text_
  // Process bold first (** and __), then italic (* and _)
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/__([^_]+)__/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  // Only strip _text_ when underscores are at word boundaries (not mid-word like snake_case)
  result = result.replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1');

  // Remove blockquote markers
  result = result.replace(/(^|\n)>\s?/g, '$1');

  // Remove horizontal rules
  result = result.replace(/(^|\n)(---+|\*\*\*+|___+)\s*($|\n)/g, '$1');

  // Collapse multiple spaces/newlines into single space
  result = result.replace(/\s+/g, ' ');

  return result.trim();
}

/**
 * Truncate a message to use as a task title (fallback behavior).
 */
export function truncateTitle(message: string, maxLength: number): string {
  if (message.length <= maxLength) return message;
  return message.slice(0, maxLength - 3) + '...';
}

export interface TaskTitleConfig {
  model?: string;
  maxLength?: number;
  timeoutMs?: number;
  enabled?: boolean;
  shortMessageThreshold?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  retryMaxDelayMs?: number;
  errorDiagnosticMaxLength?: number;
}

/** Narrow interface for the env vars read by getTaskTitleConfig. */
export interface TaskTitleEnvVars {
  TASK_TITLE_MODEL?: string;
  TASK_TITLE_MAX_LENGTH?: string;
  TASK_TITLE_TIMEOUT_MS?: string;
  TASK_TITLE_GENERATION_ENABLED?: string;
  TASK_TITLE_SHORT_MESSAGE_THRESHOLD?: string;
  TASK_TITLE_MAX_RETRIES?: string;
  TASK_TITLE_RETRY_DELAY_MS?: string;
  TASK_TITLE_RETRY_MAX_DELAY_MS?: string;
  TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH?: string;
}

export function resolveTaskTitleErrorDiagnosticMaxLength(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH;
  return Math.min(
    MAX_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH,
    Math.max(MIN_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH, Math.floor(value))
  );
}

/**
 * Read title generation config from environment variables.
 */
export function getTaskTitleConfig(env: TaskTitleEnvVars): TaskTitleConfig {
  return {
    model: env.TASK_TITLE_MODEL || DEFAULT_TASK_TITLE_MODEL,
    maxLength: parseInt(env.TASK_TITLE_MAX_LENGTH || String(DEFAULT_TASK_TITLE_MAX_LENGTH), 10),
    timeoutMs: parseInt(env.TASK_TITLE_TIMEOUT_MS || String(DEFAULT_TASK_TITLE_TIMEOUT_MS), 10),
    enabled: env.TASK_TITLE_GENERATION_ENABLED !== 'false',
    shortMessageThreshold: parseInt(
      env.TASK_TITLE_SHORT_MESSAGE_THRESHOLD || String(DEFAULT_TASK_TITLE_SHORT_MESSAGE_THRESHOLD),
      10
    ),
    maxRetries: parseInt(env.TASK_TITLE_MAX_RETRIES || String(DEFAULT_TASK_TITLE_MAX_RETRIES), 10),
    retryDelayMs: parseInt(
      env.TASK_TITLE_RETRY_DELAY_MS || String(DEFAULT_TASK_TITLE_RETRY_DELAY_MS),
      10
    ),
    retryMaxDelayMs: parseInt(
      env.TASK_TITLE_RETRY_MAX_DELAY_MS || String(DEFAULT_TASK_TITLE_RETRY_MAX_DELAY_MS),
      10
    ),
    errorDiagnosticMaxLength: resolveTaskTitleErrorDiagnosticMaxLength(
      Number(env.TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH)
    ),
  };
}

/**
 * Classify an error for logging purposes.
 * Helps operators distinguish between timeout, rate limit, and other failures.
 */
export function classifyError(err: unknown): {
  category: 'timeout' | 'rate_limit' | 'request' | 'error';
  message: string;
} {
  if (!(err instanceof Error)) {
    return { category: 'error', message: String(err) };
  }

  if (err instanceof WorkersAIGatewayError) {
    if (err.status === 429) return { category: 'rate_limit', message: err.message };
    if (err.status >= 400 && err.status < 500 && ![408, 425].includes(err.status)) {
      return { category: 'request', message: err.message };
    }
    return { category: 'error', message: err.message };
  }

  const msg = err.message.toLowerCase();

  // AbortSignal.timeout() throws a TimeoutError (DOMException with name "TimeoutError")
  // or an AbortError depending on the runtime
  if (
    err.name === 'TimeoutError' ||
    err.name === 'AbortError' ||
    msg.includes('timeout') ||
    msg.includes('abort')
  ) {
    return { category: 'timeout', message: err.message };
  }

  // Workers AI rate limit errors typically contain "rate limit" or HTTP 429 references
  if (
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('429')
  ) {
    return { category: 'rate_limit', message: err.message };
  }

  return { category: 'error', message: err.message };
}

/**
 * Sleep for a given number of milliseconds.
 * Used between retry attempts for backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface TaskTitleModelControls {
  reasoningEffort?: string | null;
  chatTemplateKwargs?: Record<string, unknown>;
}

/** Keep provider/model quirks inside an explicit capability boundary. */
export function getTaskTitleModelControls(modelId: string): TaskTitleModelControls {
  switch (modelId) {
    case '@cf/zai-org/glm-5.2':
      return { chatTemplateKwargs: { enable_thinking: false } };
    case '@cf/zai-org/glm-4.7-flash':
    case '@cf/google/gemma-4-26b-a4b-it':
      return { reasoningEffort: null, chatTemplateKwargs: { enable_thinking: false } };
    default:
      return {};
  }
}

async function fetchTaskTitle(
  env: Env,
  modelId: string,
  message: string,
  maxLength: number,
  timeoutMs: number,
  errorDiagnosticMaxLength: number
): Promise<string | null> {
  const controls = getTaskTitleModelControls(modelId);
  return fetchWorkersAIChatCompletion(env, {
    modelId,
    maxTokens: maxLength,
    timeoutMs,
    metadata: { source: 'task-title', modelId },
    responseLabel: 'task_title.gateway_response',
    reasoningEffort: controls.reasoningEffort,
    chatTemplateKwargs: controls.chatTemplateKwargs,
    errorDiagnosticMaxLength,
    messages: [
      { role: 'system', content: buildSystemInstructions(maxLength) },
      { role: 'user', content: message },
    ],
  });
}

/**
 * Generate a concise task title from a message using Workers AI via AI Gateway.
 *
 * - Short messages (≤ threshold) are returned as-is
 * - If AI generation is disabled or fails, falls back to truncation
 * - Uses AbortSignal.timeout for clean cancellation without timer leaks
 * - Retries with exponential backoff on rate-limit and generic errors (NOT timeouts)
 */
export async function generateTaskTitle(
  env: Env,
  message: string,
  config: TaskTitleConfig = {}
): Promise<string> {
  const maxLength = config.maxLength ?? DEFAULT_TASK_TITLE_MAX_LENGTH;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TASK_TITLE_TIMEOUT_MS;
  const enabled = config.enabled ?? true;
  const modelId = config.model ?? DEFAULT_TASK_TITLE_MODEL;
  const shortThreshold = config.shortMessageThreshold ?? DEFAULT_TASK_TITLE_SHORT_MESSAGE_THRESHOLD;
  const maxRetries = config.maxRetries ?? DEFAULT_TASK_TITLE_MAX_RETRIES;
  const retryDelayMs = config.retryDelayMs ?? DEFAULT_TASK_TITLE_RETRY_DELAY_MS;
  const retryMaxDelayMs = config.retryMaxDelayMs ?? DEFAULT_TASK_TITLE_RETRY_MAX_DELAY_MS;
  const errorDiagnosticMaxLength = resolveTaskTitleErrorDiagnosticMaxLength(
    config.errorDiagnosticMaxLength ?? DEFAULT_TASK_TITLE_ERROR_DIAGNOSTIC_MAX_LENGTH
  );

  // Short messages don't need AI generation
  if (message.length <= shortThreshold) {
    return message;
  }

  // Feature disabled — use truncation fallback
  if (!enabled) {
    return truncateTitle(message, maxLength);
  }

  const totalAttempts = 1 + maxRetries;
  let lastError: { category: string; message: string } | undefined;

  for (let attempt = 1; attempt <= totalAttempts; attempt++) {
    try {
      const rawTitle = await fetchTaskTitle(
        env,
        modelId,
        message,
        maxLength,
        timeoutMs,
        errorDiagnosticMaxLength
      );
      if (!rawTitle) {
        log.warn('task_title.empty_response', { modelId, messageLength: message.length, attempt });
        return truncateTitle(message, maxLength);
      }

      const title = stripMarkdown(rawTitle);
      if (!title) {
        log.warn('task_title.empty_after_strip', {
          modelId,
          rawTitle,
          messageLength: message.length,
          attempt,
        });
        return truncateTitle(message, maxLength);
      }

      return truncateTitle(title, maxLength);
    } catch (err) {
      const classified = classifyError(err);
      lastError = classified;

      const shouldRetry =
        attempt < totalAttempts && !['timeout', 'request'].includes(classified.category);

      if (shouldRetry) {
        const delay = Math.min(retryDelayMs * Math.pow(2, attempt - 1), retryMaxDelayMs);
        log.warn('task_title.retrying', {
          error: classified.message,
          category: classified.category,
          modelId,
          messageLength: message.length,
          attempt,
          totalAttempts,
          nextDelayMs: delay,
        });
        await sleep(delay);
      } else {
        log.warn('task_title.generation_failed', {
          error: classified.message,
          category: classified.category,
          modelId,
          messageLength: message.length,
          attempt,
          totalAttempts,
        });
        break;
      }
    }
  }

  // All attempts exhausted or non-retryable error — fall back to truncation
  log.warn('task_title.all_retries_exhausted', {
    modelId,
    messageLength: message.length,
    totalAttempts,
    lastErrorCategory: lastError?.category,
    lastError: lastError?.message,
  });
  return truncateTitle(message, maxLength);
}
