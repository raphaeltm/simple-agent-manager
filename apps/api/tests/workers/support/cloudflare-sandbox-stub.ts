/**
 * Test-only replacement for @cloudflare/sandbox in vitest-pool-workers.
 *
 * src/index.ts re-exports `Sandbox as SandboxDO` for production wrangler
 * bindings. The real Sandbox SDK extends Cloudflare Containers' `Container`
 * class and bootstraps container-specific RPC helpers during module
 * evaluation, which is outside the scope of these Worker/DO tests and is not
 * supported by vitest-pool-workers. Keep the Worker entry import-compatible
 * without enabling Sandbox runtime behavior in Miniflare.
 */
import { DurableObject } from 'cloudflare:workers';

export class Sandbox<Env = unknown> extends DurableObject<Env> {}

class UnsupportedSandboxClient {
  private fail(method: string): never {
    throw new Error(`@cloudflare/sandbox ${method} is not available in vitest-pool-workers`);
  }

  destroy(): Promise<void> {
    this.fail('destroy');
  }
}

export function getSandbox(..._args: unknown[]): UnsupportedSandboxClient {
  return new UnsupportedSandboxClient();
}
