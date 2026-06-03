import { Hono } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getAuth, requireApproved, requireAuth, requireSuperadmin } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  buildR2Key,
  cleanTextForSpeech,
  concatenateArrayBuffers,
  fallbackStripMarkdown,
  generateSpeechAudioChunk,
  getTTSConfig,
  splitTextIntoChunks,
  storeAudioInR2,
  summarizeTextForSpeech,
  type TTSConfig,
} from '../services/tts';

const DEFAULT_ITERATIONS = 3;
const MAX_ITERATIONS = 10;
const VARIANTS = ['baseline-full', 'parallel-chunks', 'no-cleanup', 'summary'] as const;
type BenchmarkVariantName = (typeof VARIANTS)[number];

const BENCHMARK_SECTION = `
## Cold Path Release Notes

The current text-to-speech path converts markdown-heavy task output into spoken audio. It starts with
**cleanup**, then splits text into chunks, calls the Workers AI TTS model for each chunk, concatenates
the resulting MP3 frames, and stores the final audio object in R2.

### Operational Questions

- Does the cleanup LLM dominate total latency?
- Does sequential chunk generation dominate total latency?
- Can chunk generation run in parallel without rate-limit failures?
- Is concat actually measurable, or is it effectively \`0ms\` as expected?

Inline code such as \`generateSpeechAudioChunk(text, ai, config)\` should not be read awkwardly. The cleanup
model should also remove fenced code blocks like this:

\`\`\`ts
export async function example(input: string) {
  return input.trim().toUpperCase();
}
\`\`\`

The benchmark should preserve the meaning of the content while removing markdown markers. More background is
available in [the staging verification rule](https://example.invalid/staging-rule), but links should not become
long spoken URLs. The source material also includes numbered lists:

1. Measure cleanup or summary time.
2. Measure per-chunk TTS model latency.
3. Measure byte concatenation.
4. Measure R2 storage and delete the throwaway object.

> The important detail is that this benchmark bypasses the production chunk cache. That keeps the result focused
> on cold model latency rather than cache hit behavior.

The content intentionally repeats because real task summaries often contain headings, bullets, code examples,
tables, links, and explanatory paragraphs. A representative fixture needs enough text to produce several chunks
at the default chunk size while staying below the service's maximum chunk count.
`;

const BENCHMARK_TEXT = Array.from({ length: 7 }, (_, index) =>
  `${BENCHMARK_SECTION}\n\n### Repeated Scenario ${index + 1}\n\n` +
  `This scenario describes a staging run where iteration ${index + 1} records cleanup, chunk generation, ` +
  `concat, and storage timings. It includes **bold emphasis**, _italic context_, and a reminder that ` +
  `parallel execution may surface 429 responses even when sequential execution succeeds.`
).join('\n\n---\n\n');

interface BenchmarkRequestBody {
  iterations?: number;
  variants?: BenchmarkVariantName[];
  text?: string;
}

interface BenchmarkRun {
  cleanupMs: number;
  chunkCount: number;
  perChunkMs: number[];
  chunkTotalMs: number;
  concatMs: number;
  storeMs: number;
  audioBytes: number;
  totalMs: number;
  errors: string[];
}

interface VariantResult {
  name: BenchmarkVariantName;
  runs: BenchmarkRun[];
  summary: {
    medianTotalMs: number;
    minTotalMs: number;
    maxTotalMs: number;
    medianCleanupMs: number;
    medianChunkTotalMs: number;
  };
}

const ttsBenchmarkRoutes = new Hono<{ Bindings: Env }>();

ttsBenchmarkRoutes.use('*', requireAuth(), requireApproved(), requireSuperadmin());

ttsBenchmarkRoutes.post('/', async (c) => {
  const auth = getAuth(c);
  const body = await readBody(c.req.raw);
  const iterations = parseIterations(body.iterations);
  const variants = parseVariants(body.variants);
  const text = typeof body.text === 'string' && body.text.trim().length > 0 ? body.text : BENCHMARK_TEXT;
  const config = getTTSConfig(c.env);

  if (!config.enabled) {
    throw errors.badRequest('Text-to-speech is disabled');
  }

  const results: VariantResult[] = [];
  for (const variant of variants) {
    const runs: BenchmarkRun[] = [];
    for (let i = 0; i < iterations; i++) {
      runs.push(await runVariant(variant, text, auth.user.id, c.env, config, i + 1));
    }
    results.push({ name: variant, runs, summary: summarizeRuns(runs) });
  }

  return c.json({
    config: {
      ttsModel: config.model,
      cleanupModel: config.cleanupModel,
      chunkSize: config.chunkSize,
      maxChunks: config.maxChunks,
      fixtureChars: text.length,
    },
    iterations,
    variants: results,
  });
});

async function readBody(request: Request): Promise<BenchmarkRequestBody> {
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return {};
  }
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === 'object' ? parsed as BenchmarkRequestBody : {};
  } catch {
    throw errors.badRequest('Invalid JSON body');
  }
}

function parseIterations(raw: unknown): number {
  if (raw === undefined) return DEFAULT_ITERATIONS;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > MAX_ITERATIONS) {
    throw errors.badRequest(`iterations must be an integer between 1 and ${MAX_ITERATIONS}`);
  }
  return raw;
}

function parseVariants(raw: unknown): BenchmarkVariantName[] {
  if (raw === undefined) return [...VARIANTS];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw errors.badRequest('variants must be a non-empty array');
  }
  const invalid = raw.filter((name) => !VARIANTS.includes(name));
  if (invalid.length > 0) {
    throw errors.badRequest(`Unknown variants: ${invalid.join(', ')}`);
  }
  return raw as BenchmarkVariantName[];
}

async function runVariant(
  variant: BenchmarkVariantName,
  text: string,
  userId: string,
  env: Env,
  config: TTSConfig,
  iteration: number,
): Promise<BenchmarkRun> {
  const totalStart = Date.now();
  const errorsList: string[] = [];
  const storageId = `bench_${crypto.randomUUID().replace(/-/g, '')}`;

  let cleanupMs = 0;
  let processedText = text;
  try {
    const cleanupStart = Date.now();
    if (variant === 'summary') {
      processedText = await summarizeTextForSpeech(text, env.AI, config);
    } else if (variant === 'no-cleanup') {
      processedText = fallbackStripMarkdown(text);
    } else {
      processedText = await cleanTextForSpeech(text, env.AI, config);
    }
    cleanupMs = Date.now() - cleanupStart;
    logPhase(variant, iteration, 'cleanup', { cleanupMs, inputChars: text.length, outputChars: processedText.length });
  } catch (err) {
    cleanupMs = Date.now() - totalStart;
    errorsList.push(formatError(err));
  }

  const chunkSize = config.chunkSize ?? 1800;
  const maxChunks = config.maxChunks ?? 8;
  const chunks = splitTextIntoChunks(processedText, chunkSize);
  const perChunkMs: number[] = [];
  const audioBuffers: ArrayBuffer[] = [];
  let chunkTotalMs = 0;
  let concatMs = 0;
  let storeMs = 0;
  let audioBytes = 0;

  if (chunks.length > maxChunks) {
    errorsList.push(`Text produced ${chunks.length} chunks, exceeding maxChunks ${maxChunks}`);
  } else if (errorsList.length === 0) {
    const chunkStart = Date.now();
    if (variant === 'parallel-chunks') {
      const results = await Promise.all(chunks.map(async (chunk, index) => {
        const start = Date.now();
        try {
          const buffer = await generateSpeechAudioChunk(chunk, env.AI, config);
          return { index, buffer, ms: Date.now() - start };
        } catch (err) {
          return { index, error: formatError(err), ms: Date.now() - start };
        }
      }));
      chunkTotalMs = Date.now() - chunkStart;
      for (const result of results) {
        perChunkMs[result.index] = result.ms;
        if ('buffer' in result) {
          audioBuffers[result.index] = result.buffer as ArrayBuffer;
        } else {
          errorsList.push(`chunk ${result.index + 1}: ${result.error}`);
        }
      }
    } else {
      for (const chunk of chunks) {
        const start = Date.now();
        try {
          const buffer = await generateSpeechAudioChunk(chunk, env.AI, config);
          perChunkMs.push(Date.now() - start);
          audioBuffers.push(buffer);
        } catch (err) {
          perChunkMs.push(Date.now() - start);
          errorsList.push(`chunk ${perChunkMs.length}: ${formatError(err)}`);
          break;
        }
      }
      chunkTotalMs = Date.now() - chunkStart;
    }
    logPhase(variant, iteration, 'chunks', { chunkTotalMs, chunkCount: chunks.length, perChunkMs, errors: errorsList });
  }

  if (errorsList.length === 0) {
    const concatStart = Date.now();
    const audio = concatenateArrayBuffers(audioBuffers);
    concatMs = Date.now() - concatStart;
    audioBytes = audio.byteLength;
    logPhase(variant, iteration, 'concat', { concatMs, audioBytes });

    const storeStart = Date.now();
    try {
      await storeAudioInR2(env.R2, storageId, userId, audio, config);
      storeMs = Date.now() - storeStart;
      await env.R2.delete(buildR2Key(storageId, userId, config));
    } catch (err) {
      storeMs = Date.now() - storeStart;
      errorsList.push(`store: ${formatError(err)}`);
    }
    logPhase(variant, iteration, 'store', { storeMs, storageId, errors: errorsList });
  }

  const totalMs = Date.now() - totalStart;
  logPhase(variant, iteration, 'total', { totalMs, errors: errorsList });

  return {
    cleanupMs,
    chunkCount: chunks.length,
    perChunkMs,
    chunkTotalMs,
    concatMs,
    storeMs,
    audioBytes,
    totalMs,
    errors: errorsList,
  };
}

function summarizeRuns(runs: BenchmarkRun[]): VariantResult['summary'] {
  const totals = runs.map((run) => run.totalMs);
  return {
    medianTotalMs: median(totals),
    minTotalMs: Math.min(...totals),
    maxTotalMs: Math.max(...totals),
    medianCleanupMs: median(runs.map((run) => run.cleanupMs)),
    medianChunkTotalMs: median(runs.map((run) => run.chunkTotalMs)),
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? 0;
  return Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logPhase(
  variant: BenchmarkVariantName,
  iteration: number,
  phase: string,
  data: Record<string, unknown>,
): void {
  log.info('tts_benchmark.phase', { variant, iteration, phase, ...data });
}

export { ttsBenchmarkRoutes };
