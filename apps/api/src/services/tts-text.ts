/**
 * Text preparation for TTS: LLM markdown cleanup, LLM summary, regex fallback and chunking.
 * Split from tts.ts by size; consumers import through tts.ts.
 */
import {
  DEFAULT_TTS_CHUNK_SIZE,
  DEFAULT_TTS_CLEANUP_MAX_TOKENS,
  DEFAULT_TTS_CLEANUP_MODEL,
  DEFAULT_TTS_CLEANUP_TIMEOUT_MS,
  DEFAULT_TTS_RETRY_ATTEMPTS,
  DEFAULT_TTS_RETRY_BASE_DELAY_MS,
} from '@simple-agent-manager/shared';

import { log } from '../lib/logger';
import { retryWithBackoff, type TTSConfig } from './tts-config';

// ─── Markdown Cleanup ────────────────────────────────────────────────────────

const CLEANUP_INSTRUCTIONS = `You are a text preparation assistant for text-to-speech systems. Your job is to convert markdown-formatted text into natural spoken text.

Rules:
- Output ONLY the cleaned text, nothing else
- Remove all markdown formatting (headers, bold, italic, code blocks, links, images, lists markers)
- Convert bullet points and numbered lists into natural flowing sentences
- Remove code blocks entirely — do not try to read code aloud
- Convert URLs and links into just the link text
- Expand common abbreviations if they would sound odd spoken (e.g., "e.g." → "for example")
- Keep the meaning and tone of the original text
- Do not add any commentary, explanation, or meta-text
- Output plain text only — no markdown, no HTML, no special formatting`;

const SUMMARY_INSTRUCTIONS = `You are a text summarization assistant for text-to-speech systems. Your job is to create a concise spoken summary of long content.

Rules:
- Output ONLY the summary text, nothing else
- Summarize the key points, findings, and conclusions
- Use natural spoken language — no markdown, no HTML, no special formatting
- Remove all code blocks, URLs, and technical formatting
- Keep the summary proportional: aim for roughly 10-20% of the original length
- Preserve the most important information and main arguments
- Use transitional phrases for natural flow when spoken aloud
- Do not add any commentary like "Here is a summary" — just provide the summary directly
- Do not add any meta-text or preamble`;

/**
 * Use an LLM to clean markdown/code from text, producing natural spoken text.
 * Retries on failure before falling back to basic regex stripping.
 */
export async function cleanTextForSpeech(
  text: string,
  ai: Ai,
  config: TTSConfig = {}
): Promise<string> {
  const cleanupModel = config.cleanupModel ?? DEFAULT_TTS_CLEANUP_MODEL;
  const cleanupTimeoutMs = config.cleanupTimeoutMs ?? DEFAULT_TTS_CLEANUP_TIMEOUT_MS;
  const cleanupMaxTokens = config.cleanupMaxTokens ?? DEFAULT_TTS_CLEANUP_MAX_TOKENS;
  const retryAttempts = config.retryAttempts ?? DEFAULT_TTS_RETRY_ATTEMPTS;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_TTS_RETRY_BASE_DELAY_MS;

  // If text has no markdown indicators, skip LLM cleanup
  if (!hasMarkdown(text)) {
    return text.trim();
  }

  try {
    // Load speech dependencies on demand; construct the agent once before retrying.
    const [{ Agent }, { createWorkersAI }] = await Promise.all([
      import('@mastra/core/agent'),
      import('workers-ai-provider'),
    ]);
    const workersAi = createWorkersAI({ binding: ai });
    const model = workersAi(cleanupModel as Parameters<typeof workersAi>[0]);
    const agent = new Agent({
      id: 'tts-text-cleanup',
      name: 'TTS Text Cleanup',
      instructions: CLEANUP_INSTRUCTIONS,
      model,
    });

    const cleaned = await retryWithBackoff(
      async () => {
        const result = await agent.generate(text, {
          abortSignal: AbortSignal.timeout(cleanupTimeoutMs),
          modelSettings: {
            maxOutputTokens: cleanupMaxTokens,
          },
        });

        const resultText = result.text?.trim();
        if (!resultText) {
          throw new Error('LLM returned empty cleanup result');
        }
        return resultText;
      },
      retryAttempts,
      retryBaseDelayMs,
      'cleanup'
    );

    log.info('tts.cleanup_complete', {
      inputLength: text.length,
      outputLength: cleaned.length,
      ratio: Math.round((cleaned.length / text.length) * 100),
      cleanupModel,
      cleanupMaxTokens,
    });

    return cleaned;
  } catch (err) {
    log.warn('tts.cleanup_failed', {
      error: err instanceof Error ? err.message : String(err),
      textLength: text.length,
      cleanupModel,
    });
    return fallbackStripMarkdown(text);
  }
}

/**
 * Use an LLM to summarize long text for TTS.
 * Retries on failure before falling back to truncation + regex stripping.
 */
export async function summarizeTextForSpeech(
  text: string,
  ai: Ai,
  config: TTSConfig = {}
): Promise<string> {
  const cleanupModel = config.cleanupModel ?? DEFAULT_TTS_CLEANUP_MODEL;
  const cleanupTimeoutMs = config.cleanupTimeoutMs ?? DEFAULT_TTS_CLEANUP_TIMEOUT_MS;
  const cleanupMaxTokens = config.cleanupMaxTokens ?? DEFAULT_TTS_CLEANUP_MAX_TOKENS;
  const retryAttempts = config.retryAttempts ?? DEFAULT_TTS_RETRY_ATTEMPTS;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_TTS_RETRY_BASE_DELAY_MS;

  try {
    // Load speech dependencies on demand; construct the agent once before retrying.
    const [{ Agent }, { createWorkersAI }] = await Promise.all([
      import('@mastra/core/agent'),
      import('workers-ai-provider'),
    ]);
    const workersAi = createWorkersAI({ binding: ai });
    const model = workersAi(cleanupModel as Parameters<typeof workersAi>[0]);
    const agent = new Agent({
      id: 'tts-text-summarize',
      name: 'TTS Text Summarize',
      instructions: SUMMARY_INSTRUCTIONS,
      model,
    });

    const summary = await retryWithBackoff(
      async () => {
        const result = await agent.generate(text, {
          abortSignal: AbortSignal.timeout(cleanupTimeoutMs),
          modelSettings: {
            maxOutputTokens: cleanupMaxTokens,
          },
        });

        const resultText = result.text?.trim();
        if (!resultText) {
          throw new Error('LLM returned empty summary result');
        }
        return resultText;
      },
      retryAttempts,
      retryBaseDelayMs,
      'summary'
    );

    log.info('tts.summary_complete', {
      inputLength: text.length,
      outputLength: summary.length,
      ratio: Math.round((summary.length / text.length) * 100),
      cleanupModel,
    });

    return summary;
  } catch (err) {
    log.warn('tts.summary_failed', {
      error: err instanceof Error ? err.message : String(err),
      textLength: text.length,
      cleanupModel,
    });
    const effectiveChunkSize = config.chunkSize ?? DEFAULT_TTS_CHUNK_SIZE;
    return fallbackStripMarkdown(text.slice(0, effectiveChunkSize));
  }
}

/** Quick check for common markdown patterns. */
function hasMarkdown(text: string): boolean {
  return /```|`[^`]+`|#{1,6}\s|[*_]{1,2}\S|\[.*\]\(.*\)|^\s*[-*+]\s|^\s*\d+\.\s/m.test(text);
}

/** Regex-based markdown stripping fallback (less natural than LLM but works offline). */
export function fallbackStripMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, '') // fenced code blocks
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[[^\]]*\]\(([^)]*)\)/g, '$1') // links → URL text
    .replace(/#{1,6}\s+/g, '') // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/__([^_]+)__/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1') // italic
    .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1') // italic
    .replace(/(^|\n)>\s?/g, '$1') // blockquotes
    .replace(/(^|\n)\s*[-*+]\s/g, '$1') // unordered list markers
    .replace(/(^|\n)\s*\d+\.\s/g, '$1') // ordered list markers
    .replace(/(^|\n)(---+|\*\*\*+|___+)\s*($|\n)/g, '$1') // horizontal rules
    .replace(/\n{3,}/g, '\n\n') // collapse excess newlines
    .trim();
}

// ─── Text Chunking ──────────────────────────────────────────────────────────

/**
 * Split text into chunks at sentence boundaries, respecting a max chunk size.
 * Never splits mid-word. Falls back to word boundaries if no sentence boundary
 * is found within the chunk limit.
 */
export function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  if (!text) {
    return [];
  }

  if (text.length <= maxChunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxChunkSize) {
      chunks.push(remaining);
      break;
    }

    // Look for the last sentence boundary within the chunk limit
    const window = remaining.slice(0, maxChunkSize);
    let splitIndex = -1;

    // Try sentence boundaries: ". ", "! ", "? ", ".\n", "!\n", "?\n"
    for (const sep of ['. ', '! ', '? ', '.\n', '!\n', '?\n']) {
      const idx = window.lastIndexOf(sep);
      if (idx > splitIndex) {
        // Include the punctuation but not the space/newline after it
        splitIndex = idx + 1;
      }
    }

    // Also try double newline (paragraph boundary)
    const paraIdx = window.lastIndexOf('\n\n');
    if (paraIdx > splitIndex) {
      splitIndex = paraIdx;
    }

    // Fallback: split at last space (word boundary)
    if (splitIndex <= 0) {
      const spaceIdx = window.lastIndexOf(' ');
      if (spaceIdx > 0) {
        splitIndex = spaceIdx;
      } else {
        // No space found — force split at max chunk size
        splitIndex = maxChunkSize;
      }
    }

    chunks.push(remaining.slice(0, splitIndex).trim());
    remaining = remaining.slice(splitIndex).trim();
  }

  return chunks.filter((c) => c.length > 0);
}
