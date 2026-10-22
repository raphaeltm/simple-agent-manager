import { describe, expect, it, vi } from 'vitest';

import type {
  OutputSaver,
  SavedFile,
  WorkspaceFiles,
} from '../../../../src/services/agent-models/files';
import {
  extractBase64Media,
  inlineOrSaveJson,
  outputSaver,
  resolveFileReferences,
} from '../../../../src/services/agent-models/files';

function createFiles(overrides: Partial<WorkspaceFiles> = {}): WorkspaceFiles {
  return {
    read: vi.fn(async () => ({
      data: new ArrayBuffer(0),
      contentType: 'application/octet-stream',
    })),
    write: vi.fn(async (directory: string, filename: string) => `${directory}/${filename}`),
    ...overrides,
  };
}

function createSaver(): OutputSaver {
  const saved: SavedFile[] = [];
  return {
    saved,
    save: vi.fn(async (data: ArrayBuffer | Uint8Array, contentType: string, hint: string) => {
      const file: SavedFile = {
        path: `workspace/${hint || 'file'}-${saved.length + 1}.bin`,
        contentType,
        sizeBytes: data.byteLength,
      };
      saved.push(file);
      return file;
    }),
  };
}

/** The production defaults for the file-reference cap, with a per-test byte cap. */
const limits = (maxTotalBytes: number) => ({ maxTotalBytes, maxFileReferences: 16 });

describe('resolveFileReferences', () => {
  it('replaces a $file ref with a base64-encoded string by default', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const files = createFiles({
      read: vi.fn(async () => ({ data: bytes.buffer, contentType: 'application/octet-stream' })),
    });

    const { input, fileCount } = await resolveFileReferences(
      { image: { $file: 'photo.bin' } },
      files,
      limits(1_000_000)
    );

    expect(input).toEqual({ image: Buffer.from(bytes).toString('base64') });
    expect(fileCount).toBe(1);
    expect(files.read).toHaveBeenCalledWith('photo.bin', 1_000_000);
  });

  it('replaces a $file ref with a raw byte array when encoding is "bytes"', async () => {
    const bytes = new Uint8Array([10, 20, 30]);
    const files = createFiles({
      read: vi.fn(async () => ({ data: bytes.buffer, contentType: 'application/octet-stream' })),
    });

    const { input } = await resolveFileReferences(
      { audio: { $file: 'a.raw', encoding: 'bytes' } },
      files,
      limits(1_000_000)
    );

    expect(input).toEqual({ audio: [10, 20, 30] });
  });

  it('replaces a $file ref with a data: URL when encoding is "data-url"', async () => {
    const bytes = new Uint8Array([5, 6, 7]);
    const files = createFiles({
      read: vi.fn(async () => ({ data: bytes.buffer, contentType: 'image/png; charset=binary' })),
    });

    const { input } = await resolveFileReferences(
      { image: { $file: 'p.png', encoding: 'data-url' } },
      files,
      limits(1_000_000)
    );

    expect(input).toEqual({
      image: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`,
    });
  });

  it('resolves $file references nested inside arrays and objects', async () => {
    const bytesA = new Uint8Array([1]);
    const bytesB = new Uint8Array([2]);
    const files = createFiles({
      read: vi.fn(async (path: string) => ({
        data: path === 'a.bin' ? bytesA.buffer : bytesB.buffer,
        contentType: 'application/octet-stream',
      })),
    });

    const { input, fileCount } = await resolveFileReferences(
      { items: [{ $file: 'a.bin' }, { nested: { $file: 'b.bin' } }] },
      files,
      limits(1_000_000)
    );

    expect(input).toEqual({
      items: [
        Buffer.from(bytesA).toString('base64'),
        { nested: Buffer.from(bytesB).toString('base64') },
      ],
    });
    expect(fileCount).toBe(2);
  });

  it('rejects an unsupported $file encoding', async () => {
    const files = createFiles();

    await expect(
      resolveFileReferences({ x: { $file: 'a.bin', encoding: 'base64url' } }, files, limits(1000))
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(files.read).not.toHaveBeenCalled();
  });

  it('rejects an absolute $file path', async () => {
    const files = createFiles();

    await expect(
      resolveFileReferences({ x: { $file: '/etc/passwd' } }, files, limits(1000))
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects a $file path containing ".." segments', async () => {
    const files = createFiles();

    await expect(
      resolveFileReferences({ x: { $file: '../secret.txt' } }, files, limits(1000))
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('resolves exactly 16 $file references successfully', async () => {
    const files = createFiles({
      read: vi.fn(async () => ({
        data: new ArrayBuffer(1),
        contentType: 'application/octet-stream',
      })),
    });
    const refs = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`f${index}`, { $file: `file-${index}.bin` }])
    );

    const { fileCount } = await resolveFileReferences(refs, files, limits(1_000_000));

    expect(fileCount).toBe(16);
  });

  it('refuses any $file reference when the administrator sets the cap to 0', async () => {
    const files = createFiles();
    await expect(
      resolveFileReferences({ x: { $file: 'a.bin' } }, files, {
        maxTotalBytes: 1000,
        maxFileReferences: 0,
      })
    ).rejects.toMatchObject({
      code: 'invalid_input',
      message: expect.stringContaining('turned off'),
    });
    expect(files.read).not.toHaveBeenCalled();
  });

  it('rejects more than 16 $file references in one call', async () => {
    const files = createFiles({
      read: vi.fn(async () => ({
        data: new ArrayBuffer(1),
        contentType: 'application/octet-stream',
      })),
    });
    const refs = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`f${index}`, { $file: `file-${index}.bin` }])
    );

    await expect(resolveFileReferences(refs, files, limits(1_000_000))).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('allows the total bytes across refs to equal the cap exactly', async () => {
    const files = createFiles({
      read: vi.fn(async () => ({
        data: new ArrayBuffer(10),
        contentType: 'application/octet-stream',
      })),
    });

    const { fileCount } = await resolveFileReferences({ x: { $file: 'a.bin' } }, files, limits(10));

    expect(fileCount).toBe(1);
  });

  it('rejects when the total bytes across refs exceeds the cap', async () => {
    const files = createFiles({
      read: vi.fn(async () => ({
        data: new ArrayBuffer(11),
        contentType: 'application/octet-stream',
      })),
    });

    await expect(
      resolveFileReferences({ x: { $file: 'a.bin' } }, files, limits(10))
    ).rejects.toMatchObject({ code: 'input_too_large' });
  });

  it('leaves plain values and objects without a $file key untouched', async () => {
    const files = createFiles();
    const input = { a: 1, b: 'hello', c: { d: true, e: null } };

    const { input: resolved, fileCount } = await resolveFileReferences(input, files, limits(1000));

    expect(resolved).toEqual(input);
    expect(fileCount).toBe(0);
    expect(files.read).not.toHaveBeenCalled();
  });
});

describe('extractBase64Media', () => {
  it('saves a PNG-signature base64 string nested under a key and replaces it with a $savedFile reference', async () => {
    const bytes = new Uint8Array(800);
    bytes.set([0x89, 0x50, 0x4e, 0x47], 0); // PNG magic bytes
    const base64 = Buffer.from(bytes).toString('base64');
    expect(base64.length).toBeGreaterThanOrEqual(1024);
    const saver = createSaver();

    const result = await extractBase64Media({ screenshot: base64 }, saver);

    expect(saver.save).toHaveBeenCalledTimes(1);
    const call = (saver.save as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Uint8Array,
      string,
      string,
    ];
    const [savedBytes, contentType, hint] = call;
    expect(contentType).toBe('image/png');
    expect(hint).toBe('screenshot');
    expect(new Uint8Array(savedBytes).slice(0, 4)).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    );
    expect(result).toEqual({ screenshot: { $savedFile: saver.saved[0] } });
  });

  it('leaves a short base64-looking string untouched (below the sniff threshold)', async () => {
    const saver = createSaver();
    const short = Buffer.from([1, 2, 3, 4, 5]).toString('base64');

    const result = await extractBase64Media({ note: short }, saver);

    expect(result).toEqual({ note: short });
    expect(saver.save).not.toHaveBeenCalled();
  });

  it('leaves a long normal transcript string with words and spaces untouched (not base64 at all)', async () => {
    const saver = createSaver();
    const transcript = 'This is a normal transcript with words and spaces. '.repeat(30);
    expect(transcript.length).toBeGreaterThanOrEqual(1024);

    const result = await extractBase64Media({ text: transcript }, saver);

    expect(result).toEqual({ text: transcript });
    expect(saver.save).not.toHaveBeenCalled();
  });

  it('saves an unknown-signature base64 blob at or above 64KB as application/octet-stream', async () => {
    const saver = createSaver();
    const bytes = new Uint8Array(50_000).fill(0x00);
    const base64 = Buffer.from(bytes).toString('base64');
    expect(base64.length).toBeGreaterThanOrEqual(64 * 1024);

    const result = await extractBase64Media({ blob: base64 }, saver);

    expect(saver.save).toHaveBeenCalledTimes(1);
    const call = (saver.save as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Uint8Array,
      string,
      string,
    ];
    expect(call[1]).toBe('application/octet-stream');
    expect(result).toEqual({ blob: { $savedFile: saver.saved[0] } });
  });

  it('leaves an unknown-signature base64 blob under 64KB untouched', async () => {
    const saver = createSaver();
    const bytes = new Uint8Array(2000).fill(0x00);
    const base64 = Buffer.from(bytes).toString('base64');
    expect(base64.length).toBeGreaterThanOrEqual(1024);
    expect(base64.length).toBeLessThan(64 * 1024);

    const result = await extractBase64Media({ blob: base64 }, saver);

    expect(result).toEqual({ blob: base64 });
    expect(saver.save).not.toHaveBeenCalled();
  });
});

describe('inlineOrSaveJson', () => {
  it('keeps small JSON output inline', async () => {
    const saver = createSaver();
    const value = { ok: true, count: 3 };

    const result = await inlineOrSaveJson(value, saver, 1000);

    expect(result).toEqual({ output: value, truncated: false });
    expect(saver.save).not.toHaveBeenCalled();
  });

  it('keeps JSON output inline when it is exactly at the byte limit', async () => {
    const saver = createSaver();
    const value = 'x'; // JSON.stringify('x') === '"x"', 3 bytes

    const result = await inlineOrSaveJson(value, saver, 3);

    expect(result).toEqual({ output: value, truncated: false });
    expect(saver.save).not.toHaveBeenCalled();
  });

  it('saves JSON output that exceeds the inline limit, with a preview', async () => {
    const saver = createSaver();
    const value = { text: 'x'.repeat(5000) };

    const result = await inlineOrSaveJson(value, saver, 100);

    expect(result.truncated).toBe(true);
    expect(saver.save).toHaveBeenCalledTimes(1);
    const call = (saver.save as ReturnType<typeof vi.fn>).mock.calls[0] as [
      Uint8Array,
      string,
      string,
    ];
    expect(call[1]).toBe('application/json');
    expect(call[2]).toBe('output');
    const output = result.output as { $savedFile: SavedFile; preview: string };
    expect(output.$savedFile).toBe(saver.saved[0]);
    expect(output.preview).toBe(JSON.stringify(value).slice(0, 2000));
  });
});

describe('outputSaver', () => {
  it('builds a filename shaped <model>-<YYYYMMDDTHHMMSS>-<hint>-<n>.<ext> and accumulates saved files', async () => {
    const files = createFiles();
    const now = new Date('2026-01-02T03:04:05.678Z');
    const saver = outputSaver(files, '.ai-outputs', 'clef-flash', now);

    const first = await saver.save(new Uint8Array([1, 2, 3]).buffer, 'image/png', 'photo');
    expect(first.path).toBe('.ai-outputs/clef-flash-20260102T030405-photo-1.png');
    expect(first.sizeBytes).toBe(3);
    expect(first.contentType).toBe('image/png');

    const second = await saver.save(new Uint8Array([4, 5]), 'image/png', 'photo');
    expect(second.path).toBe('.ai-outputs/clef-flash-20260102T030405-photo-2.png');
    expect(second.sizeBytes).toBe(2);

    expect(saver.saved).toEqual([first, second]);
    expect(files.write).toHaveBeenCalledTimes(2);
  });

  it('sanitizes a hint with special characters and strips leading/trailing separators', async () => {
    const files = createFiles();
    const saver = outputSaver(files, '.ai-outputs', 'model', new Date('2026-01-02T03:04:05.678Z'));

    const file = await saver.save(new ArrayBuffer(1), 'image/png', 'My Photo!!');

    expect(file.path).toBe('.ai-outputs/model-20260102T030405-My-Photo-1.png');
  });

  it('omits the hint segment entirely when the sanitized hint is empty', async () => {
    const files = createFiles();
    const saver = outputSaver(files, '.ai-outputs', 'model', new Date('2026-01-02T03:04:05.678Z'));

    const file = await saver.save(new ArrayBuffer(1), 'image/png', '!!!');

    expect(file.path).toBe('.ai-outputs/model-20260102T030405-1.png');
  });

  it('falls back to a .bin extension for an unrecognized content type', async () => {
    const files = createFiles();
    const saver = outputSaver(files, '.ai-outputs', 'model', new Date('2026-01-02T03:04:05.678Z'));

    const file = await saver.save(new ArrayBuffer(1), 'application/x-unknown-thing', 'x');

    expect(file.path).toBe('.ai-outputs/model-20260102T030405-x-1.bin');
  });
});
