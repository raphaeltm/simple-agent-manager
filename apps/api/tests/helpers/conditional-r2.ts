/**
 * An in-memory R2 bucket for key-rotation tests that enforces what the rotation relies on:
 * `list` with prefix/startAfter/limit/truncated, `head`, `delete`, and `onlyIf.etagMatches` on
 * `get` and `put` (a stale etag yields no body / null, the object is untouched), with a new etag
 * on every write. Deliberately small: it implements only those calls and throws on anything
 * else, so a test cannot pass because an unimplemented call silently did nothing.
 *
 * `ignoreOnlyIf` models a store that does not honour the preconditions (what the library pass
 * must detect and refuse, library-conditional.ts).
 */
interface StoredObject {
  body: ArrayBuffer;
  etag: string;
  customMetadata: Record<string, string>;
  httpMetadata: R2HTTPMetadata;
}

type Conditional = { onlyIf?: { etagMatches?: string } };

const toBuffer = (body: ArrayBuffer | string): ArrayBuffer =>
  typeof body === 'string' ? new TextEncoder().encode(body).buffer : body.slice(0);

export class ConditionalR2 {
  private readonly objects = new Map<string, StoredObject>();
  private generation = 0;
  /** Called just before a conditional put is evaluated (to inject a concurrent writer). */
  beforePut: ((key: string) => void) | null = null;
  /** Called just before a get is evaluated (to inject a concurrent writer). */
  beforeGet: ((key: string) => void) | null = null;
  /** Pretend the store ignores `onlyIf` on get and/or put. */
  ignoreOnlyIf: { get?: boolean; put?: boolean } = {};

  private nextEtag(): string {
    this.generation += 1;
    return `etag-${this.generation}`;
  }

  private stale(options: Conditional, stored: StoredObject | undefined, op: 'get' | 'put') {
    const wanted = options.onlyIf?.etagMatches;
    return Boolean(wanted) && !this.ignoreOnlyIf[op] && wanted !== stored?.etag;
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

  keys(): string[] {
    return [...this.objects.keys()];
  }

  list(options: { prefix?: string; limit?: number; startAfter?: string }) {
    const keys = [...this.objects.keys()]
      .filter((key) => key.startsWith(options.prefix ?? ''))
      .filter((key) => !options.startAfter || key > options.startAfter)
      .sort((a, b) => a.localeCompare(b));
    const limit = options.limit ?? 1000;
    return Promise.resolve({
      objects: keys.slice(0, limit).map((key) => ({ key })),
      truncated: keys.length > limit,
    });
  }

  head(key: string) {
    const stored = this.objects.get(key);
    return Promise.resolve(
      stored
        ? {
            key,
            etag: stored.etag,
            customMetadata: { ...stored.customMetadata },
            httpMetadata: { ...stored.httpMetadata },
          }
        : null
    );
  }

  get(key: string, options: Conditional = {}) {
    this.beforeGet?.(key);
    const stored = this.objects.get(key);
    if (!stored) return Promise.resolve(null);
    if (this.stale(options, stored, 'get')) return Promise.resolve({ key, etag: stored.etag });
    const body = stored.body.slice(0);
    return Promise.resolve({
      key,
      etag: stored.etag,
      body: new Response(body).body,
      arrayBuffer: () => Promise.resolve(body),
      text: () => Promise.resolve(new TextDecoder().decode(body)),
    });
  }

  put(
    key: string,
    body: ArrayBuffer | string,
    options: Conditional & {
      customMetadata?: Record<string, string>;
      httpMetadata?: R2HTTPMetadata;
    } = {}
  ) {
    this.beforePut?.(key);
    if (this.stale(options, this.objects.get(key), 'put')) return Promise.resolve(null);
    const etag = this.nextEtag();
    this.objects.set(key, {
      body: toBuffer(body),
      etag,
      customMetadata: { ...options.customMetadata },
      httpMetadata: { ...options.httpMetadata },
    });
    return Promise.resolve({ key, etag });
  }

  delete(key: string) {
    this.objects.delete(key);
    return Promise.resolve();
  }

  asBucket(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}
