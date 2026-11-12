/**
 * Every binding and variable repo hosting reads (GitHub App and user OAuth, GitLab, repository
 * browsing). The worker `Env` extends it, so the compiler proves the deployed Worker provides
 * each one. What repo hosting needs from other areas of the worker goes through
 * `RepoHostingPorts`, never through wider env fields.
 */
export interface RepoHostingEnv {
  DATABASE: D1Database;
  /** Installation-token and tree caches. */
  KV: KVNamespace;
  /** Per-user OAuth token refresh locks (Durable Objects); calls use `stub.fetch` only. */
  GITHUB_USER_ACCESS_TOKEN_LOCK: DurableObjectNamespace;
  GITLAB_USER_ACCESS_TOKEN_LOCK?: DurableObjectNamespace;
  // Cloudflare Artifacts for SAM-native Git repos (optional — absent when ARTIFACTS_ENABLED is falsy)
  ARTIFACTS?: {
    create(
      name: string,
      opts?: { description?: string; setDefaultBranch?: string }
    ): Promise<{
      id: string;
      name: string;
      remote: string;
      token: string;
      default_branch: string;
    }>;
    delete(name: string): Promise<boolean>;
    get(name: string): Promise<{
      id: string;
      name: string;
      remote: string;
      defaultBranch: string;
      createToken(
        scope?: 'read' | 'write',
        ttl?: number
      ): Promise<{
        id: string;
        plaintext: string;
        scope: string;
        expiresAt?: string;
        expires_at?: string;
      }>;
    }>;
  };
  ARTIFACTS_ENABLED?: string;
  ARTIFACTS_TOKEN_TTL_SECONDS?: string;
  GITHUB_INSTALLATION_LEAK_SWEEP_BATCH_SIZE?: string;
  GITHUB_INSTALLATION_TOKEN_CACHE_TTL_SECONDS?: string;
  GITHUB_INSTALLATION_TOKEN_REFRESH_MARGIN_SECONDS?: string;
  GITHUB_REPO_ID_BACKFILL_BATCH_SIZE?: string;
  GITHUB_TREE_CACHE_TTL_SECONDS?: string;
  GITLAB_API_TIMEOUT_MS?: string;
  MAX_BRANCHES_PER_REPO?: string;
  REPO_BROWSE_MAX_COMPARE_FILES?: string;
  REPO_BROWSE_MAX_INLINE_BYTES?: string;
}

/** Short alias used throughout the repo-hosting modules. */
export type Env = RepoHostingEnv;

/**
 * The part of a Hono request context the per-request token helpers read. The worker's
 * `Context<{ Bindings: Env }>` satisfies it, so routes pass `c` unchanged.
 */
export interface RepoHostingRequestContext {
  env: RepoHostingEnv;
  req: { raw: Request };
}
