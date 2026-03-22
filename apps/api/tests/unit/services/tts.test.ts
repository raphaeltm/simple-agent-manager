import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  cleanTextForSpeech,
  summarizeTextForSpeech,
  fallbackStripMarkdown,
  generateSpeechAudio,
  generateSpeechAudioChunk,
  splitTextIntoChunks,
  concatenateArrayBuffers,
  buildR2Key,
  buildChunkR2Key,
  simpleHash,
  getAudioFromR2,
  storeAudioInR2,
  synthesizeSpeech,
  getTTSConfig,
  retryWithBackoff,
} from '../../../src/services/tts';

// Mock @mastra/core/agent — factory must not reference outer variables
const mockGenerate = vi.fn().mockResolvedValue({ text: 'This is clean text for speech.' });
vi.mock('@mastra/core/agent', () => ({
  Agent: vi.fn().mockImplementation(() => ({
    generate: mockGenerate,
  })),
}));

// Mock workers-ai-provider
vi.mock('workers-ai-provider', () => ({
  createWorkersAI: vi.fn().mockReturnValue(
    vi.fn().mockReturnValue({ modelId: 'test-model' })
  ),
}));

// Minimal mock for Ai binding
function createMockAi(): Ai {
  const mockRun = vi.fn();
  return { run: mockRun } as unknown as Ai;
}

// Mock R2 bucket
function createMockR2(): R2Bucket {
  return {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
    head: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    createMultipartUpload: vi.fn(),
    resumeMultipartUpload: vi.fn(),
  } as unknown as R2Bucket;
}

// ─── retryWithBackoff ────────────────────────────────────────────────────────

describe('retryWithBackoff', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('success');
    const result = await retryWithBackoff(fn, 3, 10, 'test');
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on Nth attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockRejectedValueOnce(new Error('fail 2'))
      .mockResolvedValue('success');

    const result = await retryWithBackoff(fn, 3, 10, 'test');
    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws last error after exhausting all attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent failure'));

    await expect(retryWithBackoff(fn, 3, 10, 'test')).rejects.toThrow('persistent failure');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('converts non-Error throws to Error', async () => {
    const fn = vi.fn().mockRejectedValue('string error');

    await expect(retryWithBackoff(fn, 1, 10, 'test')).rejects.toThrow('string error');
  });
});

// ─── fallbackStripMarkdown ───────────────────────────────────────────────────

describe('fallbackStripMarkdown', () => {
  it('returns plain text unchanged', () => {
    expect(fallbackStripMarkdown('Hello world')).toBe('Hello world');
  });

  it('removes fenced code blocks', () => {
    const input = 'Before\n```js\nconst x = 1;\n```\nAfter';
    expect(fallbackStripMarkdown(input)).toBe('Before\n\nAfter');
  });

  it('removes inline code backticks', () => {
    expect(fallbackStripMarkdown('Use the `console.log` function')).toBe('Use the console.log function');
  });

  it('removes heading markers', () => {
    expect(fallbackStripMarkdown('## Important Heading')).toBe('Important Heading');
  });

  it('removes bold markers', () => {
    expect(fallbackStripMarkdown('This is **bold** text')).toBe('This is bold text');
  });

  it('removes italic markers', () => {
    expect(fallbackStripMarkdown('This is *italic* text')).toBe('This is italic text');
  });

  it('removes images', () => {
    expect(fallbackStripMarkdown('![alt](http://img.png)')).toBe('');
  });

  it('converts links to URL text', () => {
    expect(fallbackStripMarkdown('[click here](http://example.com)')).toBe('http://example.com');
  });

  it('removes unordered list markers', () => {
    const input = '- Item one\n- Item two';
    const result = fallbackStripMarkdown(input);
    expect(result).toContain('Item one');
    expect(result).toContain('Item two');
    expect(result).not.toContain('- ');
  });

  it('removes ordered list markers', () => {
    const input = '1. First\n2. Second';
    const result = fallbackStripMarkdown(input);
    expect(result).toContain('First');
    expect(result).toContain('Second');
  });

  it('collapses excess newlines', () => {
    const input = 'A\n\n\n\nB';
    expect(fallbackStripMarkdown(input)).toBe('A\n\nB');
  });
});

// ─── cleanTextForSpeech ──────────────────────────────────────────────────────

describe('cleanTextForSpeech', () => {
  beforeEach(() => {
    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ text: 'This is clean text for speech.' });
  });

  it('returns plain text without LLM call when no markdown detected', async () => {
    const ai = createMockAi();
    const result = await cleanTextForSpeech('Hello world, no markdown here.', ai);
    expect(result).toBe('Hello world, no markdown here.');
    // Should not call the LLM for plain text
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it('calls LLM for text with markdown', async () => {
    const ai = createMockAi();
    const result = await cleanTextForSpeech('## Heading\n\n**Bold** text with `code`', ai);
    expect(result).toBe('This is clean text for speech.');
    expect(mockGenerate).toHaveBeenCalledOnce();
  });

  it('falls back to regex stripping when LLM returns empty after all retries', async () => {
    mockGenerate.mockRejectedValue(new Error('LLM returned empty cleanup result'));
    const ai = createMockAi();
    const result = await cleanTextForSpeech('## Heading\n**bold**', ai, { retryAttempts: 1 });
    // Should use fallback, not return empty
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain('##');
    expect(result).not.toContain('**');
  });

  it('falls back to regex stripping when LLM returns empty string', async () => {
    // Specifically test the empty-string guard: generate resolves but text is empty
    mockGenerate.mockResolvedValue({ text: '' });
    const ai = createMockAi();
    const result = await cleanTextForSpeech('## Heading\n**bold**', ai, { retryAttempts: 1 });
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain('##');
    expect(result).not.toContain('**');
  });

  it('falls back to regex stripping when LLM throws after all retries', async () => {
    mockGenerate.mockRejectedValue(new Error('AI service unavailable'));
    const ai = createMockAi();
    const result = await cleanTextForSpeech('## Heading\n**bold** text', ai, { retryAttempts: 1 });
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain('##');
  });

  it('retries before falling back to regex on LLM failure', async () => {
    mockGenerate
      .mockRejectedValueOnce(new Error('fail 1'))
      .mockResolvedValue({ text: 'Cleaned text after retry.' });
    const ai = createMockAi();
    const result = await cleanTextForSpeech('## Heading', ai, { retryAttempts: 2, retryBaseDelayMs: 10 });
    expect(result).toBe('Cleaned text after retry.');
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });

  it('passes maxOutputTokens to agent.generate() via modelSettings', async () => {
    const ai = createMockAi();
    await cleanTextForSpeech('## Heading with **markdown**', ai, { cleanupMaxTokens: 8192 });
    expect(mockGenerate).toHaveBeenCalledOnce();
    const callArgs = mockGenerate.mock.calls[0]!;
    expect(callArgs[1]).toMatchObject({
      modelSettings: { maxOutputTokens: 8192 },
    });
  });

  it('uses default cleanup max tokens when not specified', async () => {
    const ai = createMockAi();
    await cleanTextForSpeech('## Heading with **markdown**', ai);
    expect(mockGenerate).toHaveBeenCalledOnce();
    const callArgs = mockGenerate.mock.calls[0]!;
    expect(callArgs[1]).toMatchObject({
      modelSettings: { maxOutputTokens: 4096 },
    });
  });
});

// ─── summarizeTextForSpeech ──────────────────────────────────────────────────

describe('summarizeTextForSpeech', () => {
  beforeEach(() => {
    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ text: 'This is a concise summary of the text.' });
  });

  it('calls LLM to summarize text', async () => {
    const ai = createMockAi();
    const result = await summarizeTextForSpeech('A very long text that needs summarizing.', ai);
    expect(result).toBe('This is a concise summary of the text.');
    expect(mockGenerate).toHaveBeenCalledOnce();
  });

  it('falls back to truncated regex-stripped text when LLM fails after all retries', async () => {
    mockGenerate.mockRejectedValue(new Error('LLM returned empty summary result'));
    const ai = createMockAi();
    const longText = 'A'.repeat(10000);
    const result = await summarizeTextForSpeech(longText, ai, { retryAttempts: 1 });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('falls back to truncated regex-stripped text when LLM throws after all retries', async () => {
    mockGenerate.mockRejectedValue(new Error('AI unavailable'));
    const ai = createMockAi();
    const longText = 'B'.repeat(10000);
    const result = await summarizeTextForSpeech(longText, ai, { retryAttempts: 1 });
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(1800);
  });

  it('retries before falling back on LLM failure', async () => {
    mockGenerate
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue({ text: 'Summary after retry.' });
    const ai = createMockAi();
    const result = await summarizeTextForSpeech('Some text', ai, { retryAttempts: 2, retryBaseDelayMs: 10 });
    expect(result).toBe('Summary after retry.');
    expect(mockGenerate).toHaveBeenCalledTimes(2);
  });
});

// ─── splitTextIntoChunks ────────────────────────────────────────────────────

describe('splitTextIntoChunks', () => {
  it('returns single chunk for short text', () => {
    const chunks = splitTextIntoChunks('Hello world.', 100);
    expect(chunks).toEqual(['Hello world.']);
  });

  it('splits at sentence boundaries', () => {
    const text = 'First sentence. Second sentence. Third sentence.';
    const chunks = splitTextIntoChunks(text, 25);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should end at a sentence boundary
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk).toMatch(/[.!?]$/);
    }
    // Concatenating should preserve all content
    const joined = chunks.join(' ');
    expect(joined).toContain('First sentence.');
    expect(joined).toContain('Second sentence.');
    expect(joined).toContain('Third sentence.');
  });

  it('splits at paragraph boundaries', () => {
    const text = 'Paragraph one content here.\n\nParagraph two content here.\n\nParagraph three content here.';
    const chunks = splitTextIntoChunks(text, 40);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('falls back to word boundaries when no sentence boundary found', () => {
    // Long text with no sentence-ending punctuation
    const text = 'word '.repeat(100).trim();
    const chunks = splitTextIntoChunks(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    // No chunk should start or end with a space (trimmed)
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/^\s/);
      expect(chunk).not.toMatch(/\s$/);
    }
  });

  it('handles text with no spaces by force-splitting', () => {
    const text = 'a'.repeat(100);
    const chunks = splitTextIntoChunks(text, 30);
    expect(chunks.length).toBeGreaterThan(1);
    // Total content should be preserved
    expect(chunks.join('').length).toBe(100);
  });

  it('handles empty string', () => {
    const chunks = splitTextIntoChunks('', 100);
    expect(chunks).toEqual([]);
  });

  it('handles exact chunk size text', () => {
    const text = 'a'.repeat(100);
    const chunks = splitTextIntoChunks(text, 100);
    expect(chunks).toEqual([text]);
  });

  it('preserves all content across chunks', () => {
    const sentences = Array.from({ length: 20 }, (_, i) => `Sentence number ${i + 1} with some content.`);
    const text = sentences.join(' ');
    const chunks = splitTextIntoChunks(text, 200);

    // All original sentences should appear in the chunked output
    const reassembled = chunks.join(' ');
    for (const sentence of sentences) {
      expect(reassembled).toContain(`Sentence number ${sentence.match(/\d+/)![0]}`);
    }
  });

  it('never produces chunks exceeding the configured max size', () => {
    // Generate realistic long text with varied sentence lengths
    const sentences = [
      'This is a short sentence.',
      'Here is a much longer sentence that contains significantly more words and should help test the chunking behavior with realistic text content.',
      'Another sentence.',
      'The quick brown fox jumps over the lazy dog, and this sentence keeps going with additional clauses to make it longer than usual for testing purposes.',
      'Short one.',
      'Medium length sentence with some words in it.',
    ];
    const text = Array.from({ length: 50 }, (_, i) => sentences[i % sentences.length]).join(' ');

    for (const maxSize of [100, 500, 1800, 2000]) {
      const chunks = splitTextIntoChunks(text, maxSize);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(maxSize);
      }
    }
  });
});

// ─── concatenateArrayBuffers ────────────────────────────────────────────────

describe('concatenateArrayBuffers', () => {
  it('concatenates multiple buffers', () => {
    const buf1 = new Uint8Array([1, 2, 3]).buffer;
    const buf2 = new Uint8Array([4, 5]).buffer;
    const buf3 = new Uint8Array([6]).buffer;

    const result = concatenateArrayBuffers([buf1, buf2, buf3]);
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it('handles single buffer', () => {
    const buf = new Uint8Array([1, 2, 3]).buffer;
    const result = concatenateArrayBuffers([buf]);
    expect(new Uint8Array(result)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('handles empty array', () => {
    const result = concatenateArrayBuffers([]);
    expect(result.byteLength).toBe(0);
  });
});

// ─── generateSpeechAudioChunk ────────────────────────────────────────────────

describe('generateSpeechAudioChunk', () => {
  it('calls AI.run with correct parameters and returns audio buffer', async () => {
    const fakeAudio = new ArrayBuffer(1024);
    const ai = createMockAi();
    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    const result = await generateSpeechAudioChunk('Hello world', ai, {
      model: '@cf/deepgram/aura-2-en',
      speaker: 'luna',
      encoding: 'mp3',
      retryAttempts: 1,
    });

    expect(ai.run).toHaveBeenCalledWith(
      '@cf/deepgram/aura-2-en',
      { text: 'Hello world', speaker: 'luna', encoding: 'mp3' },
      { returnRawResponse: true },
    );
    expect(result.byteLength).toBe(1024);
  });

  it('throws when response is not ok after all retries', async () => {
    const ai = createMockAi();
    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(generateSpeechAudioChunk('Hello', ai, { retryAttempts: 1 })).rejects.toThrow('TTS model returned 500');
  });

  it('retries and succeeds on second attempt', async () => {
    const fakeAudio = new ArrayBuffer(512);
    const ai = createMockAi();
    (ai.run as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve('Service Unavailable'),
      })
      .mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeAudio),
      });

    const result = await generateSpeechAudioChunk('Hello', ai, { retryAttempts: 2, retryBaseDelayMs: 10 });
    expect(result.byteLength).toBe(512);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it('throws timeout error when AI call takes too long', async () => {
    const ai = createMockAi();
    // Mock ai.run to never resolve, triggering the timeout
    (ai.run as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise(() => {/* never resolves */}),
    );

    await expect(
      generateSpeechAudioChunk('Hello', ai, { timeoutMs: 50, retryAttempts: 1 }),
    ).rejects.toThrow('TTS generation timed out after 50ms');
  });

  it('retries on empty audio buffer', async () => {
    const fakeAudio = new ArrayBuffer(256);
    const ai = createMockAi();
    (ai.run as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
      })
      .mockResolvedValue({
        ok: true,
        arrayBuffer: () => Promise.resolve(fakeAudio),
      });

    const result = await generateSpeechAudioChunk('Hello', ai, { retryAttempts: 2, retryBaseDelayMs: 10 });
    expect(result.byteLength).toBe(256);
    expect(ai.run).toHaveBeenCalledTimes(2);
  });
});

// ─── generateSpeechAudio (with chunking) ────────────────────────────────────

describe('generateSpeechAudio', () => {
  it('generates single chunk for short text', async () => {
    const fakeAudio = new ArrayBuffer(1024);
    const ai = createMockAi();
    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    const result = await generateSpeechAudio('Short text.', ai, { chunkSize: 1800, retryAttempts: 1 });
    expect(ai.run).toHaveBeenCalledTimes(1);
    expect(result.byteLength).toBe(1024);
  });

  it('chunks long text and concatenates audio buffers', async () => {
    const ai = createMockAi();
    let callCount = 0;
    (ai.run as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callCount++;
      const buf = new Uint8Array([callCount]).buffer;
      return Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(buf),
      });
    });

    // Create text that will be split into multiple chunks
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence ${i + 1} with content.`);
    const text = sentences.join(' ');

    const result = await generateSpeechAudio(text, ai, { chunkSize: 50, maxChunks: 20, retryAttempts: 1 });

    // Should have made multiple AI calls
    expect(callCount).toBeGreaterThan(1);

    // Result should be concatenation of all chunk buffers
    const resultArray = new Uint8Array(result);
    expect(resultArray.length).toBe(callCount);
    // Each byte should be the sequential call number
    for (let i = 0; i < callCount; i++) {
      expect(resultArray[i]).toBe(i + 1);
    }
  });

  it('throws when chunk count exceeds maxChunks', async () => {
    const ai = createMockAi();
    // Create text that would produce many chunks
    const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1} here.`).join(' ');

    await expect(
      generateSpeechAudio(text, ai, { chunkSize: 30, maxChunks: 3 })
    ).rejects.toThrow(/exceeding limit of 3/);

    // Should not have called AI at all
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('uses per-chunk R2 cache when R2 bucket is provided', async () => {
    const ai = createMockAi();
    const r2 = createMockR2();
    const cachedChunkAudio = new ArrayBuffer(100);
    const freshChunkAudio = new ArrayBuffer(200);

    // First R2 get is for the final audio cache check (returns null — not cached).
    // Then per-chunk R2 gets: first chunk is cached, rest are not.
    let chunkGetCalls = 0;
    (r2.get as ReturnType<typeof vi.fn>).mockImplementation(() => {
      chunkGetCalls++;
      if (chunkGetCalls === 1) {
        // Final audio cache miss
        return Promise.resolve(null);
      }
      if (chunkGetCalls === 2) {
        // First chunk cache hit
        return Promise.resolve({
          arrayBuffer: () => Promise.resolve(cachedChunkAudio),
        });
      }
      // All other chunk cache misses
      return Promise.resolve(null);
    });

    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(freshChunkAudio),
    });

    // Use synthesizeSpeech to trigger the full pipeline (which checks final cache then per-chunk)
    mockGenerate.mockResolvedValue({ text: 'First sentence is here. Second sentence is here.' });
    const result = await synthesizeSpeech(
      '## First sentence is here. Second sentence is here.',
      'test-storage', ai, r2,
      { chunkSize: 30, maxChunks: 10, retryAttempts: 1 },
      'user-1',
    );

    // At least one chunk came from cache (reducing AI calls)
    expect(result.cached).toBe(false);
    // R2 put should have been called for the non-cached chunks + final audio
    expect(r2.put).toHaveBeenCalled();
    // The cached chunk should have reduced the number of AI TTS calls.
    // Total chunks depends on text + chunkSize, but ai.run should be called
    // fewer times than r2.get chunk checks (minus the final audio cache check).
    const totalAiCalls = (ai.run as ReturnType<typeof vi.fn>).mock.calls.length;
    const totalChunkGetCalls = chunkGetCalls - 1; // subtract the final audio cache check
    expect(totalAiCalls).toBeLessThan(totalChunkGetCalls);
  });
});

// ─── R2 Storage ──────────────────────────────────────────────────────────────

describe('buildR2Key', () => {
  it('builds default key with tts prefix, userId, and mp3 extension', () => {
    expect(buildR2Key('msg-123', 'user-1')).toBe('tts/user-1/msg-123.mp3');
  });

  it('respects custom prefix and encoding', () => {
    expect(buildR2Key('msg-456', 'user-2', { r2Prefix: 'audio', encoding: 'wav' })).toBe('audio/user-2/msg-456.wav');
  });
});

describe('buildChunkR2Key', () => {
  it('builds chunk key with index and text hash', () => {
    const key = buildChunkR2Key('msg-123', 'user-1', 0, 'Hello world');
    expect(key).toMatch(/^tts\/user-1\/msg-123_chunk_0_[a-z0-9]+\.mp3$/);
  });

  it('produces different keys for different chunk text', () => {
    const key1 = buildChunkR2Key('msg-123', 'user-1', 0, 'Hello');
    const key2 = buildChunkR2Key('msg-123', 'user-1', 0, 'World');
    expect(key1).not.toBe(key2);
  });

  it('produces different keys for different chunk indexes', () => {
    const key1 = buildChunkR2Key('msg-123', 'user-1', 0, 'Hello');
    const key2 = buildChunkR2Key('msg-123', 'user-1', 1, 'Hello');
    expect(key1).not.toBe(key2);
  });
});

describe('simpleHash', () => {
  it('produces consistent hash for same input', () => {
    expect(simpleHash('hello')).toBe(simpleHash('hello'));
  });

  it('produces different hashes for different inputs', () => {
    expect(simpleHash('hello')).not.toBe(simpleHash('world'));
  });

  it('returns a base36 string', () => {
    const hash = simpleHash('test');
    expect(hash).toMatch(/^[a-z0-9]+$/);
  });
});

describe('getAudioFromR2', () => {
  it('returns null when audio does not exist', async () => {
    const r2 = createMockR2();
    const result = await getAudioFromR2(r2, 'nonexistent', 'user-1');
    expect(result).toBeNull();
    expect(r2.get).toHaveBeenCalledWith('tts/user-1/nonexistent.mp3');
  });

  it('returns the R2 object when audio exists', async () => {
    const r2 = createMockR2();
    const fakeBody = { body: new ReadableStream(), size: 1024 };
    (r2.get as ReturnType<typeof vi.fn>).mockResolvedValue(fakeBody);
    const result = await getAudioFromR2(r2, 'existing-msg', 'user-1');
    expect(result).toBe(fakeBody);
  });
});

describe('storeAudioInR2', () => {
  it('stores audio bytes with correct key and content type', async () => {
    const r2 = createMockR2();
    const audio = new ArrayBuffer(512);
    await storeAudioInR2(r2, 'msg-789', 'user-1', audio);
    expect(r2.put).toHaveBeenCalledWith('tts/user-1/msg-789.mp3', audio, {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
  });

  it('uses correct content type for wav encoding', async () => {
    const r2 = createMockR2();
    const audio = new ArrayBuffer(512);
    await storeAudioInR2(r2, 'msg-wav', 'user-1', audio, { encoding: 'wav' });
    expect(r2.put).toHaveBeenCalledWith('tts/user-1/msg-wav.wav', audio, {
      httpMetadata: { contentType: 'audio/wav' },
    });
  });
});

// ─── synthesizeSpeech (orchestrator) ─────────────────────────────────────────

describe('synthesizeSpeech', () => {
  beforeEach(() => {
    mockGenerate.mockClear();
    mockGenerate.mockResolvedValue({ text: 'Clean spoken text' });
  });

  it('returns cached audio from R2 without generating', async () => {
    const r2 = createMockR2();
    const fakeBody = new ReadableStream();
    (r2.get as ReturnType<typeof vi.fn>).mockResolvedValue({
      body: fakeBody,
      size: 1024,
    });

    const ai = createMockAi();
    const result = await synthesizeSpeech('Some text', 'cached-id', ai, r2, {}, 'user-1');

    expect(result.cached).toBe(true);
    expect(result.audioBody).toBe(fakeBody);
    expect(result.contentType).toBe('audio/mpeg');
    expect(result.summarized).toBe(false);
    // Should not call AI for generation
    expect(ai.run).not.toHaveBeenCalled();
  });

  it('generates and stores audio when not cached', async () => {
    const r2 = createMockR2();
    const ai = createMockAi();
    const fakeAudio = new ArrayBuffer(2048);

    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    const result = await synthesizeSpeech('## Hello **world**', 'new-id', ai, r2, { retryAttempts: 1 }, 'user-1');

    expect(result.cached).toBe(false);
    expect(result.summarized).toBe(false);
    expect(result.audioBody).toBe(fakeAudio);
    expect(result.contentType).toBe('audio/mpeg');
    // Should store in R2
    expect(r2.put).toHaveBeenCalledWith('tts/user-1/new-id.mp3', fakeAudio, {
      httpMetadata: { contentType: 'audio/mpeg' },
    });
  });

  it('truncates text that exceeds maxTextLength', async () => {
    const r2 = createMockR2();
    const ai = createMockAi();
    const fakeAudio = new ArrayBuffer(512);

    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    // Use markdown text so LLM cleanup path is triggered
    const longText = '## ' + 'a'.repeat(10000);
    await synthesizeSpeech(longText, 'long-id', ai, r2, { maxTextLength: 100, retryAttempts: 1 }, 'user-1');

    // The LLM cleanup should have been called with the truncated text
    expect(mockGenerate).toHaveBeenCalled();
    const callArg = mockGenerate.mock.calls[0]![0] as string;
    expect(callArg.length).toBeLessThanOrEqual(100);
  });

  it('throws when TTS model returns empty audio after retries', async () => {
    const r2 = createMockR2();
    const ai = createMockAi();

    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    await expect(synthesizeSpeech('Hello', 'empty-id', ai, r2, { retryAttempts: 1 }, 'user-1'))
      .rejects.toThrow('TTS model returned empty audio buffer');
  });

  it('uses summary mode when text exceeds summary threshold', async () => {
    const r2 = createMockR2();
    const ai = createMockAi();
    const fakeAudio = new ArrayBuffer(512);

    mockGenerate.mockResolvedValue({ text: 'A brief summary of the content.' });

    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    const longText = 'x'.repeat(60000);
    const result = await synthesizeSpeech(longText, 'summary-id', ai, r2, {
      summaryThreshold: 50000,
      retryAttempts: 1,
    }, 'user-1');

    expect(result.summarized).toBe(true);
    expect(result.cached).toBe(false);
  });

  it('uses full mode for text below summary threshold', async () => {
    const r2 = createMockR2();
    const ai = createMockAi();
    const fakeAudio = new ArrayBuffer(512);

    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    const result = await synthesizeSpeech('Short text.', 'full-id', ai, r2, {
      summaryThreshold: 50000,
      retryAttempts: 1,
    }, 'user-1');

    expect(result.summarized).toBe(false);
  });

  it('respects explicit mode override', async () => {
    const r2 = createMockR2();
    const ai = createMockAi();
    const fakeAudio = new ArrayBuffer(512);

    mockGenerate.mockResolvedValue({ text: 'Summary of short text.' });

    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    // Force summary mode even for short text
    const result = await synthesizeSpeech('Short text.', 'force-summary-id', ai, r2, { retryAttempts: 1 }, 'user-1', 'summary');

    expect(result.summarized).toBe(true);
  });
});

// ─── getTTSConfig ────────────────────────────────────────────────────────────

describe('getTTSConfig', () => {
  it('returns defaults when no env vars set', () => {
    const config = getTTSConfig({});
    expect(config.model).toBe('@cf/deepgram/aura-2-en');
    expect(config.speaker).toBe('luna');
    expect(config.encoding).toBe('mp3');
    expect(config.cleanupModel).toBe('@cf/google/gemma-3-12b-it');
    expect(config.cleanupMaxTokens).toBe(4096);
    expect(config.maxTextLength).toBe(100000);
    expect(config.timeoutMs).toBe(60000);
    expect(config.cleanupTimeoutMs).toBe(15000);
    expect(config.r2Prefix).toBe('tts');
    expect(config.enabled).toBe(true);
    expect(config.chunkSize).toBe(1800);
    expect(config.maxChunks).toBe(8);
    expect(config.summaryThreshold).toBe(14400);
    expect(config.retryAttempts).toBe(3);
    expect(config.retryBaseDelayMs).toBe(500);
  });

  it('reads overrides from env vars', () => {
    const config = getTTSConfig({
      TTS_MODEL: '@cf/myshell-ai/melotts',
      TTS_SPEAKER: 'asteria',
      TTS_ENCODING: 'wav',
      TTS_CLEANUP_MODEL: '@cf/meta/llama-3.1-8b-instruct',
      TTS_CLEANUP_MAX_TOKENS: '8192',
      TTS_MAX_TEXT_LENGTH: '200000',
      TTS_TIMEOUT_MS: '90000',
      TTS_CLEANUP_TIMEOUT_MS: '30000',
      TTS_R2_PREFIX: 'audio-cache',
      TTS_CHUNK_SIZE: '8000',
      TTS_MAX_CHUNKS: '12',
      TTS_SUMMARY_THRESHOLD: '100000',
      TTS_RETRY_ATTEMPTS: '5',
      TTS_RETRY_BASE_DELAY_MS: '1000',
    });
    expect(config.model).toBe('@cf/myshell-ai/melotts');
    expect(config.speaker).toBe('asteria');
    expect(config.encoding).toBe('wav');
    expect(config.cleanupModel).toBe('@cf/meta/llama-3.1-8b-instruct');
    expect(config.cleanupMaxTokens).toBe(8192);
    expect(config.maxTextLength).toBe(200000);
    expect(config.timeoutMs).toBe(90000);
    expect(config.cleanupTimeoutMs).toBe(30000);
    expect(config.r2Prefix).toBe('audio-cache');
    expect(config.chunkSize).toBe(8000);
    expect(config.maxChunks).toBe(12);
    expect(config.summaryThreshold).toBe(100000);
    expect(config.retryAttempts).toBe(5);
    expect(config.retryBaseDelayMs).toBe(1000);
  });

  it('disables TTS when TTS_ENABLED is false', () => {
    const config = getTTSConfig({ TTS_ENABLED: 'false' });
    expect(config.enabled).toBe(false);
  });

  it('enables TTS for any other value of TTS_ENABLED', () => {
    expect(getTTSConfig({ TTS_ENABLED: 'true' }).enabled).toBe(true);
    expect(getTTSConfig({ TTS_ENABLED: '' }).enabled).toBe(true);
  });
});
