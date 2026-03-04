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
 */

import { Agent } from '@mastra/core/agent';
import { createWorkersAI } from 'workers-ai-provider';
import {
  DEFAULT_TASK_TITLE_MODEL,
  DEFAULT_TASK_TITLE_MAX_LENGTH,
  DEFAULT_TASK_TITLE_TIMEOUT_MS,
  TASK_TITLE_SHORT_MESSAGE_THRESHOLD,
} from '@simple-agent-manager/shared';
import { log } from '../lib/logger';

const SYSTEM_INSTRUCTIONS = `You are a task title generator. Given a task description, produce a single concise title.

Rules:
- Output ONLY the title text, nothing else
- No quotes, no prefixes, no explanation
- Maximum {maxLength} characters
- Capture the core intent of the task
- Use imperative mood (e.g., "Add dark mode toggle" not "Adding dark mode toggle")
- Be specific — "Fix login timeout" is better than "Fix bug"`;

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
}

/**
 * Read title generation config from environment variables.
 */
export function getTaskTitleConfig(env: Record<string, string | undefined>): TaskTitleConfig {
  return {
    model: env.TASK_TITLE_MODEL || DEFAULT_TASK_TITLE_MODEL,
    maxLength: parseInt(env.TASK_TITLE_MAX_LENGTH || String(DEFAULT_TASK_TITLE_MAX_LENGTH), 10),
    timeoutMs: parseInt(env.TASK_TITLE_TIMEOUT_MS || String(DEFAULT_TASK_TITLE_TIMEOUT_MS), 10),
    enabled: env.TASK_TITLE_GENERATION_ENABLED !== 'false',
  };
}

/**
 * Generate a concise task title from a message using Workers AI via Mastra.
 *
 * - Short messages (≤ threshold) are returned as-is
 * - If AI generation is disabled or fails, falls back to truncation
 * - Enforces a timeout to prevent slow AI calls from blocking task submission
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

  // Short messages don't need AI generation
  if (message.length <= TASK_TITLE_SHORT_MESSAGE_THRESHOLD) {
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
      instructions: SYSTEM_INSTRUCTIONS.replace('{maxLength}', String(maxLength)),
      model,
    });

    // Race AI generation against timeout
    const result = await Promise.race([
      agent.generate(message),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Task title generation timed out')), timeoutMs)
      ),
    ]);

    const title = result.text?.trim();
    if (!title) {
      log.warn('task_title.empty_response', { modelId, messageLength: message.length });
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
