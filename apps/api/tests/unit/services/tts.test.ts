import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  cleanTextForSpeech,
  fallbackStripMarkdown,
  generateSpeechAudio,
  buildR2Key,
  getAudioFromR2,
  storeAudioInR2,
  synthesizeSpeech,
  getTTSConfig,
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

  it('falls back to regex stripping when LLM returns empty', async () => {
    mockGenerate.mockResolvedValue({ text: '' });
    const ai = createMockAi();
    const result = await cleanTextForSpeech('## Heading\n**bold**', ai);
    // Should use fallback, not return empty
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain('##');
    expect(result).not.toContain('**');
  });

  it('falls back to regex stripping when LLM throws', async () => {
    mockGenerate.mockRejectedValue(new Error('AI service unavailable'));
    const ai = createMockAi();
    const result = await cleanTextForSpeech('## Heading\n**bold** text', ai);
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toContain('##');
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

// ─── generateSpeechAudio ────────────────────────────────────────────────────

describe('generateSpeechAudio', () => {
  it('calls AI.run with correct parameters and returns audio buffer', async () => {
    const fakeAudio = new ArrayBuffer(1024);
    const ai = createMockAi();
    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(fakeAudio),
    });

    const result = await generateSpeechAudio('Hello world', ai, {
      model: '@cf/deepgram/aura-2-en',
      speaker: 'luna',
      encoding: 'mp3',
    });

    expect(ai.run).toHaveBeenCalledWith(
      '@cf/deepgram/aura-2-en',
      { text: 'Hello world', speaker: 'luna', encoding: 'mp3' },
      { returnRawResponse: true },
    );
    expect(result.byteLength).toBe(1024);
  });

  it('throws when response is not ok', async () => {
    const ai = createMockAi();
    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(generateSpeechAudio('Hello', ai)).rejects.toThrow('TTS model returned 500');
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

    const result = await synthesizeSpeech('## Hello **world**', 'new-id', ai, r2, {}, 'user-1');

    expect(result.cached).toBe(false);
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
    await synthesizeSpeech(longText, 'long-id', ai, r2, { maxTextLength: 100 }, 'user-1');

    // The LLM cleanup should have been called with the truncated text
    expect(mockGenerate).toHaveBeenCalled();
    const callArg = mockGenerate.mock.calls[0]![0] as string;
    expect(callArg.length).toBeLessThanOrEqual(100);
  });

  it('throws when TTS model returns empty audio', async () => {
    const r2 = createMockR2();
    const ai = createMockAi();

    (ai.run as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    });

    await expect(synthesizeSpeech('Hello', 'empty-id', ai, r2, {}, 'user-1'))
      .rejects.toThrow('TTS model returned empty audio');
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
    expect(config.maxTextLength).toBe(10000);
    expect(config.timeoutMs).toBe(60000);
    expect(config.cleanupTimeoutMs).toBe(15000);
    expect(config.r2Prefix).toBe('tts');
    expect(config.enabled).toBe(true);
  });

  it('reads overrides from env vars', () => {
    const config = getTTSConfig({
      TTS_MODEL: '@cf/myshell-ai/melotts',
      TTS_SPEAKER: 'asteria',
      TTS_ENCODING: 'wav',
      TTS_CLEANUP_MODEL: '@cf/meta/llama-3.1-8b-instruct',
      TTS_CLEANUP_MAX_TOKENS: '8192',
      TTS_MAX_TEXT_LENGTH: '20000',
      TTS_TIMEOUT_MS: '90000',
      TTS_CLEANUP_TIMEOUT_MS: '30000',
      TTS_R2_PREFIX: 'audio-cache',
    });
    expect(config.model).toBe('@cf/myshell-ai/melotts');
    expect(config.speaker).toBe('asteria');
    expect(config.encoding).toBe('wav');
    expect(config.cleanupModel).toBe('@cf/meta/llama-3.1-8b-instruct');
    expect(config.cleanupMaxTokens).toBe(8192);
    expect(config.maxTextLength).toBe(20000);
    expect(config.timeoutMs).toBe(90000);
    expect(config.cleanupTimeoutMs).toBe(30000);
    expect(config.r2Prefix).toBe('audio-cache');
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
