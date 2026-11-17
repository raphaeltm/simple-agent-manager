import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireLibraryMemory,
  loadLibraryDownload,
  withLibraryMemory,
} from '../../../src/services/library-memory';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function available() {
  const release = acquireLibraryMemory();
  release();
}
afterEach(() => vi.useRealTimers());

describe('Library memory ownership', () => {
  it('rejects overlapping owners without queuing and releases idempotently', () => {
    const release = acquireLibraryMemory();
    expect(() => acquireLibraryMemory()).toThrow(/in progress/);
    release();
    const next = acquireLibraryMemory();
    release(); // A stale release cannot release the next owner.
    expect(() => acquireLibraryMemory()).toThrow(/in progress/);
    next();
    available();
  });

  it.each([false, true])('holds callback ownership until settlement (failure=%s)', async (fail) => {
    const pending = deferred<void>();
    const operation = withLibraryMemory(async () => {
      await pending.promise;
      if (fail) throw new Error('storage failed');
      return 7;
    });
    expect(() => acquireLibraryMemory()).toThrow(/in progress/);
    pending.resolve();
    if (fail) await expect(operation).rejects.toThrow('storage failed');
    else await expect(operation).resolves.toBe(7);
    available();
  });

  it.each([false, true])(
    'retains timed-out load until its late settlement (failure=%s)',
    async (fail) => {
      vi.useFakeTimers();
      const pending = deferred<{ data: ArrayBuffer }>();
      const result = loadLibraryDownload(() => pending.promise, 100);
      const rejection = expect(result).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(() => acquireLibraryMemory()).toThrow(/in progress/);
      const data = new Uint8Array(10).buffer;
      if (fail) pending.reject(new Error('late storage failure'));
      else pending.resolve({ data });
      await Promise.resolve();
      await Promise.resolve();
      if (!fail) expect(data.byteLength).toBe(0);
      available();
    }
  );

  it('releases a load failure immediately without waiting for its deadline', async () => {
    await expect(
      loadLibraryDownload(async () => {
        throw new Error('R2 unavailable');
      }, 1000)
    ).rejects.toThrow('R2 unavailable');
    available();
  });

  it('holds response plaintext after load and streams bounded copies through a range', async () => {
    const source = Uint8Array.from({ length: 160_000 }, (_, i) => i % 251);
    const expected = source.slice(123, 150_321);
    const owner = await loadLibraryDownload(
      async () => ({ data: source.buffer, name: 'file' }),
      10_000
    );
    expect(owner.value.name).toBe('file');
    const stream = owner.stream(123, 150_321);
    expect(() => acquireLibraryMemory()).toThrow(/in progress/);
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      expect(result.value.byteLength).toBeLessThanOrEqual(64 * 1024);
      chunks.push(result.value);
      if (chunks.length === 1) expect(() => acquireLibraryMemory()).toThrow(/in progress/);
    }
    const actual = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      actual.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(actual).toEqual(expected);
    expect(source.buffer.byteLength).toBe(0);
    owner.dispose();
    available();
  });

  it('does not prefetch an unconsumed response and cancellation releases plaintext', async () => {
    const data = new Uint8Array(100_000).buffer;
    const owner = await loadLibraryDownload(async () => ({ data }), 1000);
    const stream = owner.stream();
    await Promise.resolve();
    expect(data.byteLength).toBe(100_000);
    expect(() => acquireLibraryMemory()).toThrow(/in progress/);
    await stream.cancel();
    expect(data.byteLength).toBe(0);
    available();
  });

  it.each([false, true])(
    'expires abandoned plaintext ownership (stream started=%s)',
    async (started) => {
      vi.useFakeTimers();
      const data = new Uint8Array(100_000).buffer;
      const owner = await loadLibraryDownload(async () => ({ data }), 100);
      const stream = started ? owner.stream() : undefined;
      await vi.advanceTimersByTimeAsync(100);
      expect(data.byteLength).toBe(0);
      if (stream) await expect(stream.getReader().read()).rejects.toThrow(/timed out/);
      else expect(() => owner.stream()).toThrow(/disposed|timed out/);
      owner.dispose();
      available();
    }
  );

  it('dispose invalidates a live stream and stale disposal cannot release a successor', async () => {
    const data = new Uint8Array(100_000).buffer;
    const owner = await loadLibraryDownload(async () => ({ data }), 1000);
    const stream = owner.stream();
    owner.dispose();
    expect(data.byteLength).toBe(0);
    await expect(stream.getReader().read()).rejects.toThrow(/disposed/);
    const next = acquireLibraryMemory();
    owner.dispose();
    expect(() => acquireLibraryMemory()).toThrow(/in progress/);
    next();
  });

  it.each([false, true])(
    'retains callback consumers past egress timeout until settlement (failure=%s)',
    async (fail) => {
      vi.useFakeTimers();
      const data = new Uint8Array(100_000).buffer;
      const owner = await loadLibraryDownload(async () => ({ data }), 100);
      const pending = deferred<void>();
      const consumer = owner.consume(async (value) => {
        expect(value.data.byteLength).toBe(100_000);
        await pending.promise;
        expect(value.data.byteLength).toBe(100_000);
        if (fail) throw new Error('VM transfer failed');
        return 'consumed';
      });
      await vi.advanceTimersByTimeAsync(1000);
      owner.dispose(); // Disposing the caller cannot cancel the live VM transfer.
      expect(data.byteLength).toBe(100_000);
      expect(() => acquireLibraryMemory()).toThrow(/in progress/);
      expect(() => owner.stream()).toThrow(/already created/);
      await expect(owner.consume(async () => 0)).rejects.toThrow(/already created/);
      pending.resolve();
      if (fail) await expect(consumer).rejects.toThrow('VM transfer failed');
      else await expect(consumer).resolves.toBe('consumed');
      expect(data.byteLength).toBe(0);
      available();
    }
  );

  it('rejects duplicate streams and disposes an empty range without emitting bytes', async () => {
    const data = new Uint8Array(12).buffer;
    const owner = await loadLibraryDownload(async () => ({ data }), 1000);
    const stream = owner.stream(4, 4);
    expect(() => owner.stream()).toThrow(/stream/);
    expect(await stream.getReader().read()).toEqual({ done: true, value: undefined });
    expect(data.byteLength).toBe(0);
    available();
  });
});
