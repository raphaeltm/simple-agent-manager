/**
 * An in-memory R2 bucket for key-rotation tests that enforces what the rotation relies on:
 * `list` with prefix/startAfter/limit/truncated, `head`, and `onlyIf.etagMatches` on `get` and
 * `put` (a stale etag yields null, the object is untouched), with a new etag on every write.
 * Deliberately small: it implements only those calls and throws on anything else, so a test
 * cannot pass because an unimplemented call silently did nothing.
 */
interface StoredObject {
  body: ArrayBuffer;
  etag: string;
  customMetadata: Record<string, string>;
  httpMetadata: R2HTTPMetadata;
}

type Conditional = { onlyIf?: { etagMatches?: string } };

export class ConditionalR2 {
  private objects = new Map<string, StoredObject>();
  private generation = 0;
  /** Called just before a conditional put is evaluated (to inject a concurrent writer). */
  beforePut: ((key: string) => void) | null = null;

  private nextEtag(): string {
    this.generation += 1;
    return `etag-${this.generation}`;
  }

  set(
    key: string,
    body: ArrayBuffer,
    customMetadata: Record<string, string>,
    httpMetadata: R2HTTPMetadata = {}
  ): void {
    this.objects.set(key, { body, customMetadata, httpMetadata, etag: this.nextEtag() });
  }

  object(key: string): StoredObject | undefined {
    return this.objects.get(key);
  }

  async list(options: { prefix?: string; limit?: number; startAfter?: string }) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ''))
      .filter((key) => !options.startAfter || key > options.startAfter)
      .sort();
    const limit = options.limit ?? 1000;
    return {
      objects: keys.slice(0, limit).map((key) => ({ key })),
      truncated: keys.length > limit,
    };
  }

  async head(key: string) {
    const stored = this.objects.get(key);
    return stored
      ? {
          key,
          etag: stored.etag,
          customMetadata: { ...stored.customMetadata },
          httpMetadata: { ...stored.httpMetadata },
        }
      : null;
  }

  async get(key: string, options: Conditional = {}) {
    const stored = this.objects.get(key);
    if (!stored) return null;
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== stored.etag)
      return { key, etag: stored.etag };
    const body = stored.body.slice(0);
    return { key, etag: stored.etag, body: new Response(body).body, arrayBuffer: async () => body };
  }

  async put(
    key: string,
    body: ArrayBuffer,
    options: Conditional & {
      customMetadata?: Record<string, string>;
      httpMetadata?: R2HTTPMetadata;
    } = {}
  ) {
    this.beforePut?.(key);
    const stored = this.objects.get(key);
    if (options.onlyIf?.etagMatches && options.onlyIf.etagMatches !== stored?.etag) return null;
    const etag = this.nextEtag();
    this.objects.set(key, {
      body: body.slice(0),
      etag,
      customMetadata: { ...(options.customMetadata ?? {}) },
      httpMetadata: { ...(options.httpMetadata ?? {}) },
    });
    return { key, etag };
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}
