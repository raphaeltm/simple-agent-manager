/**
 * AI-powered task title generation using Mastra + Cloudflare Workers AI.
 *
 * Uses a small LLM to generate concise, descriptive task titles from
 * long-form chat messages. Falls back to naive truncation on failure.
 *
 * Architecture:
 *   Workers AI binding (env.AI)
 *     → workers-ai-provider (Vercel AI SDK bridge)
 *       → Mastra Agent (structured AI interaction)
 *         → concise task title
 *
 * Design decision: the AI call is synchronous (awaited before DB insert)
 * rather than async via waitUntil. This keeps the title consistent across
 * the task record, session label, and activity event, and avoids a second
 * DB write. The timeout (configurable, default 5s) bounds worst-case latency.
 */

import { Agent } from '@mastra/core/agent';
import { createWorkersAI } from 'workers-ai-provider';
import {
  DEFAULT_TASK_TITLE_MODEL,
  DEFAULT_TASK_TITLE_MAX_LENGTH,
  DEFAULT_TASK_TITLE_TIMEOUT_MS,
  DEFAULT_TASK_TITLE_SHORT_MESSAGE_THRESHOLD,
} from '@simple-agent-manager/shared';
import { log } from '../lib/logger';

/**
 * Build the system instructions for the title generation agent.
 * Uses a function instead of string replacement to make the maxLength
 * dependency explicit and avoid silent no-ops if the template changes.
 */
function buildSystemInstructions(maxLength: number): string {
  return `You are a task title generator. Given a task description, produce a single concise title.

Rules:
- Output ONLY the title text, nothing else
- No markdown formatting (no bold, headings, backticks, underscores, or other markup)
- No quotes, no prefixes, no explanation
- Maximum ${maxLength} characters
- Capture the core intent of the task
- Use imperative mood (e.g., "Add dark mode toggle" not "Adding dark mode toggle")
- Be specific — "Fix login timeout" is better than "Fix bug"`;
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
}

/** Narrow interface for the env vars read by getTaskTitleConfig. */
export interface TaskTitleEnvVars {
  TASK_TITLE_MODEL?: string;
  TASK_TITLE_MAX_LENGTH?: string;
  TASK_TITLE_TIMEOUT_MS?: string;
  TASK_TITLE_GENERATION_ENABLED?: string;
  TASK_TITLE_SHORT_MESSAGE_THRESHOLD?: string;
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
      10,
    ),
  };
}

/**
 * Generate a concise task title from a message using Workers AI via Mastra.
 *
 * - Short messages (≤ threshold) are returned as-is
 * - If AI generation is disabled or fails, falls back to truncation
 * - Uses AbortSignal.timeout for clean cancellation without timer leaks
 */
export async function generateTaskTitle(
  ai: Ai,
  message: string,
  config: TaskTitleConfig = {},
): Promise<string> {
  const maxLength = config.maxLength ?? DEFAULT_TASK_TITLE_MAX_LENGTH;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TASK_TITLE_TIMEOUT_MS;
  const enabled = config.enabled ?? true;
  const modelId = config.model ?? DEFAULT_TASK_TITLE_MODEL;
  const shortThreshold = config.shortMessageThreshold ?? DEFAULT_TASK_TITLE_SHORT_MESSAGE_THRESHOLD;

  // Short messages don't need AI generation
  if (message.length <= shortThreshold) {
    return message;
  }

  // Feature disabled — use truncation fallback
  if (!enabled) {
    return truncateTitle(message, maxLength);
  }

  try {
    const workersAi = createWorkersAI({ binding: ai });
    const model = workersAi(modelId as Parameters<typeof workersAi>[0]);

    const agent = new Agent({
      id: 'task-title-generator',
      name: 'Task Title Generator',
      instructions: buildSystemInstructions(maxLength),
      model,
    });

    // Use AbortSignal.timeout for clean cancellation without timer leaks.
    // Supported in Workers runtime since compatibility_date 2023-03-14.
    const result = await agent.generate(message, {
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    const rawTitle = result.text?.trim();
    if (!rawTitle) {
      log.warn('task_title.empty_response', { modelId, messageLength: message.length });
      return truncateTitle(message, maxLength);
    }

    // Strip markdown formatting that the LLM may have included despite instructions
    const title = stripMarkdown(rawTitle);
    if (!title) {
      log.warn('task_title.empty_after_strip', { modelId, rawTitle, messageLength: message.length });
      return truncateTitle(message, maxLength);
    }

    // Enforce max length on LLM output (models sometimes exceed the limit)
    return truncateTitle(title, maxLength);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn('task_title.generation_failed', {
      error: errorMsg,
      modelId,
      messageLength: message.length,
    });
    return truncateTitle(message, maxLength);
  }
}
