/**
 * AI-powered session summarization for conversation forking.
 *
 * Generates a structured context summary from a chat session's messages,
 * enabling users to continue work in a new task with context from a
 * completed/stopped session.
 *
 * Architecture:
 *   ProjectData DO (message source)
 *     → filter (keep user + assistant, exclude tool/system/thinking/plan)
 *       → chunk (strategy varies by message count)
 *         → Workers AI via Mastra Agent → structured summary
 *
 * Fallback: If AI fails or times out, produces a heuristic summary by
 * concatenating the last N messages with role labels + task metadata.
 *
 * Follows the same patterns as task-title.ts: Mastra Agent, timeout,
 * retry with exponential backoff, and graceful fallback.
 */

import { Agent } from '@mastra/core/agent';
import { createWorkersAI } from 'workers-ai-provider';
import {
  DEFAULT_CONTEXT_SUMMARY_MODEL,
  DEFAULT_CONTEXT_SUMMARY_MAX_LENGTH,
  DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS,
  DEFAULT_CONTEXT_SUMMARY_MAX_MESSAGES,
  DEFAULT_CONTEXT_SUMMARY_RECENT_MESSAGES,
  DEFAULT_CONTEXT_SUMMARY_SHORT_THRESHOLD,
} from '@simple-agent-manager/shared';
import { log } from '../lib/logger';
import { classifyError } from './task-title';

/** Message shape expected from the ProjectData DO. */
export interface SummarizeMessage {
  role: string;
  content: string;
  created_at: number;
}

export interface SummarizeConfig {
  model?: string;
  maxLength?: number;
  timeoutMs?: number;
  maxMessages?: number;
  recentMessages?: number;
  shortThreshold?: number;
}

export interface SummarizeResult {
  summary: string;
  messageCount: number;
  filteredCount: number;
  method: 'ai' | 'heuristic' | 'verbatim';
}

/** Metadata about the parent task, used to enrich both AI and heuristic summaries. */
export interface TaskContext {
  title?: string;
  description?: string;
  outputBranch?: string;
  outputPrUrl?: string;
  outputSummary?: string;
}

/** Narrow interface for env vars read by getSummarizeConfig. */
export interface SummarizeEnvVars {
  CONTEXT_SUMMARY_MODEL?: string;
  CONTEXT_SUMMARY_MAX_LENGTH?: string;
  CONTEXT_SUMMARY_TIMEOUT_MS?: string;
  CONTEXT_SUMMARY_MAX_MESSAGES?: string;
  CONTEXT_SUMMARY_RECENT_MESSAGES?: string;
  CONTEXT_SUMMARY_SHORT_THRESHOLD?: string;
}

/** Read summarization config from environment variables. */
export function getSummarizeConfig(env: SummarizeEnvVars): SummarizeConfig {
  return {
    model: env.CONTEXT_SUMMARY_MODEL || DEFAULT_CONTEXT_SUMMARY_MODEL,
    maxLength: parseInt(env.CONTEXT_SUMMARY_MAX_LENGTH || String(DEFAULT_CONTEXT_SUMMARY_MAX_LENGTH), 10),
    timeoutMs: parseInt(env.CONTEXT_SUMMARY_TIMEOUT_MS || String(DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS), 10),
    maxMessages: parseInt(env.CONTEXT_SUMMARY_MAX_MESSAGES || String(DEFAULT_CONTEXT_SUMMARY_MAX_MESSAGES), 10),
    recentMessages: parseInt(
      env.CONTEXT_SUMMARY_RECENT_MESSAGES || String(DEFAULT_CONTEXT_SUMMARY_RECENT_MESSAGES),
      10,
    ),
    shortThreshold: parseInt(
      env.CONTEXT_SUMMARY_SHORT_THRESHOLD || String(DEFAULT_CONTEXT_SUMMARY_SHORT_THRESHOLD),
      10,
    ),
  };
}

/** Roles to keep for summarization. */
const SUMMARY_ROLES = new Set(['user', 'assistant']);

/**
 * Filter messages to keep only user and assistant roles.
 */
export function filterMessages(messages: SummarizeMessage[]): SummarizeMessage[] {
  return messages.filter((m) => SUMMARY_ROLES.has(m.role));
}

/**
 * Apply chunking strategy based on the number of filtered messages.
 *
 * Strategy:
 * - ≤ maxMessages: keep all
 * - > maxMessages: keep first 5 (original context) + last `recentMessages` (current state)
 */
export function chunkMessages(
  messages: SummarizeMessage[],
  maxMessages: number,
  recentMessages: number,
): SummarizeMessage[] {
  if (messages.length <= maxMessages) {
    return messages;
  }

  const headCount = 5;
  const tailCount = Math.min(recentMessages, messages.length - headCount);
  const head = messages.slice(0, headCount);
  const tail = messages.slice(-tailCount);

  return [...head, ...tail];
}

/**
 * Truncate individual message content for large conversations.
 * Messages in conversations with > 50 filtered messages get truncated.
 */
function truncateMessageContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  return content.slice(0, maxChars - 3) + '...';
}

/**
 * Format messages for inclusion in the AI prompt or heuristic summary.
 */
export function formatMessagesForPrompt(
  messages: SummarizeMessage[],
  totalFiltered: number,
): string {
  const maxContentChars = totalFiltered > 50 ? 300 : totalFiltered > 20 ? 500 : Infinity;

  return messages
    .map((m) => {
      const role = m.role === 'user' ? 'User' : 'Agent';
      const content = truncateMessageContent(m.content, maxContentChars);
      return `${role}: ${content}`;
    })
    .join('\n\n');
}

/**
 * Build the system instructions for the summarization agent.
 */
function buildSystemInstructions(maxLength: number): string {
  return `You are a conversation summarizer for an AI coding agent platform. Given a conversation between a user and a coding agent, produce a structured context summary that will help a NEW agent instance continue the work.

The new agent has NO memory of this conversation. It needs to understand:
1. What was the original task/goal?
2. What files were discussed or modified?
3. What key decisions were made?
4. What is the current state of the work?
5. What remains to be done (if anything)?

Rules:
- Focus on ACTIONABLE context, not play-by-play narration
- List specific file paths that were mentioned or modified
- Note any git branch names mentioned
- Prioritize the most recent state over historical progression
- Maximum ${maxLength} characters
- Output in markdown with clear section headers
- Use these sections: "## Original Task", "## Files Modified", "## Key Decisions", "## Current State", "## Remaining Work"
- If a section has no relevant content, omit it entirely
- Be concise — the summary should be scannable in 30 seconds`;
}

/**
 * Build a heuristic fallback summary from messages and task metadata.
 * Used when AI summarization fails or is unavailable.
 */
export function buildHeuristicSummary(
  messages: SummarizeMessage[],
  taskContext?: TaskContext,
): string {
  const parts: string[] = [];

  parts.push('## Previous Session Context');
  parts.push('');

  if (taskContext) {
    if (taskContext.title) parts.push(`**Task**: ${taskContext.title}`);
    if (taskContext.outputBranch) parts.push(`**Branch**: ${taskContext.outputBranch}`);
    if (taskContext.outputPrUrl) parts.push(`**PR**: ${taskContext.outputPrUrl}`);
    if (taskContext.outputSummary) {
      parts.push('');
      parts.push('**Agent Summary**:');
      parts.push(taskContext.outputSummary);
    }
    parts.push('');
  }

  if (messages.length > 0) {
    parts.push('## Recent Conversation');
    parts.push('');
    // Take last 10 messages
    const recent = messages.slice(-10);
    for (const m of recent) {
      const role = m.role === 'user' ? 'User' : 'Agent';
      const content = truncateMessageContent(m.content, 500);
      parts.push(`**${role}**: ${content}`);
      parts.push('');
    }
  }

  return parts.join('\n').trim();
}

/**
 * Generate a context summary from a session's messages.
 *
 * - Very short sessions (≤ shortThreshold filtered messages) return verbatim
 * - Otherwise, uses Workers AI to generate a structured summary
 * - Falls back to heuristic extraction on AI failure
 */
export async function summarizeSession(
  ai: Ai,
  allMessages: SummarizeMessage[],
  config: SummarizeConfig = {},
  taskContext?: TaskContext,
): Promise<SummarizeResult> {
  const maxLength = config.maxLength ?? DEFAULT_CONTEXT_SUMMARY_MAX_LENGTH;
  const timeoutMs = config.timeoutMs ?? DEFAULT_CONTEXT_SUMMARY_TIMEOUT_MS;
  const modelId = config.model ?? DEFAULT_CONTEXT_SUMMARY_MODEL;
  const maxMessages = config.maxMessages ?? DEFAULT_CONTEXT_SUMMARY_MAX_MESSAGES;
  const recentMessages = config.recentMessages ?? DEFAULT_CONTEXT_SUMMARY_RECENT_MESSAGES;
  const shortThreshold = config.shortThreshold ?? DEFAULT_CONTEXT_SUMMARY_SHORT_THRESHOLD;

  const messageCount = allMessages.length;
  const filtered = filterMessages(allMessages);
  const filteredCount = filtered.length;

  // Very short sessions: include verbatim
  if (filteredCount <= shortThreshold) {
    const verbatim = buildHeuristicSummary(filtered, taskContext);
    return { summary: verbatim, messageCount, filteredCount, method: 'verbatim' };
  }

  // Chunk messages for AI input
  const chunked = chunkMessages(filtered, maxMessages, recentMessages);
  const messagesText = formatMessagesForPrompt(chunked, filteredCount);

  // Build AI prompt with task context
  let promptInput = '';
  if (taskContext) {
    const contextParts: string[] = [];
    if (taskContext.title) contextParts.push(`Task: ${taskContext.title}`);
    if (taskContext.outputBranch) contextParts.push(`Branch: ${taskContext.outputBranch}`);
    if (taskContext.outputPrUrl) contextParts.push(`PR: ${taskContext.outputPrUrl}`);
    if (contextParts.length > 0) {
      promptInput += contextParts.join('\n') + '\n\n';
    }
  }
  promptInput += messagesText;

  // Try AI summarization
  try {
    const workersAi = createWorkersAI({ binding: ai });
    const model = workersAi(modelId as Parameters<typeof workersAi>[0]);
    const agent = new Agent({
      id: 'session-summarizer',
      name: 'Session Summarizer',
      instructions: buildSystemInstructions(maxLength),
      model,
    });

    const result = await agent.generate(promptInput, {
      abortSignal: AbortSignal.timeout(timeoutMs),
    });

    const summary = result.text?.trim();
    if (!summary) {
      log.warn('session_summarize.empty_response', { modelId, messageCount, filteredCount });
      return {
        summary: buildHeuristicSummary(filtered, taskContext),
        messageCount,
        filteredCount,
        method: 'heuristic',
      };
    }

    // Enforce max length
    const truncated = summary.length > maxLength ? summary.slice(0, maxLength - 3) + '...' : summary;

    return { summary: truncated, messageCount, filteredCount, method: 'ai' };
  } catch (err) {
    const classified = classifyError(err);
    log.warn('session_summarize.ai_failed', {
      error: classified.message,
      category: classified.category,
      modelId,
      messageCount,
      filteredCount,
    });

    // Fall back to heuristic summary
    return {
      summary: buildHeuristicSummary(filtered, taskContext),
      messageCount,
      filteredCount,
      method: 'heuristic',
    };
  }
}
