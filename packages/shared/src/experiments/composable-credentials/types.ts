/**
 * EXPERIMENT (E2) — Composable Credentials & Configurations: typed primitives.
 *
 * This is throwaway experimental code exploring the three-primitive model from
 * idea 01KV05VNSSQDCSGPAGS47BK20N. It is NOT wired into the app and NOT exported
 * from the package index. It exists to give us concrete interfaces to critique
 * and to prove (via the parity harness in `parity.test.ts`) that a single
 * generalized resolver can reproduce today's two parallel resolution chains
 * byte-for-byte.
 *
 * The three primitives:
 *   1. Credential    — a named, typed, AGENT-AGNOSTIC secret owned by a user.
 *   2. Configuration — a named composition: consumer + credential ref + settings.
 *   3. Attachment    — binds a configuration into a scope (user-default or
 *                      project-override).
 *
 * Key correction baked in here vs. the current schema: `agentType` is NOT a
 * property of the credential. One OpenAI auth.json can feed both Codex and
 * OpenCode. The binding "this secret drives that consumer" lives on the
 * Configuration layer (`consumer`), never on the Credential.
 */

// =============================================================================
// Primitive 1 — Credential (agent-agnostic, named, typed secret)
// =============================================================================

/** Discriminator for the shape of the decrypted secret material. */
export type CredentialKind =
  | 'api-key' // single bearer string (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...)
  | 'oauth-token' // subscription OAuth token (Claude Max, ChatGPT)
  | 'openai-compatible' // base URL + key (z.ai, custom OpenAI-compatible endpoints)
  | 'cloud-provider' // provider blob used to construct a compute Provider
  | 'auth-json'; // opaque JSON blob (Codex ~/.codex/auth.json)

/** The decrypted secret material, discriminated by `kind`. */
export type CredentialSecret =
  | { kind: 'api-key'; apiKey: string }
  | { kind: 'oauth-token'; token: string; refreshToken?: string }
  | { kind: 'openai-compatible'; apiKey: string; baseUrl: string }
  | { kind: 'cloud-provider'; provider: string; token: string }
  | { kind: 'auth-json'; authJson: string };

/**
 * A named secret owned by a user. In storage `secret` is encrypted
 * (AES-256-GCM); the resolved form carries the decrypted material.
 *
 * `name` is the new dimension the current schema lacks — it is what lets a user
 * hold multiple credentials of the same kind ("Personal Anthropic",
 * "Work Anthropic") instead of the current one-per-slot singleton.
 */
export interface Credential {
  id: string;
  ownerId: string;
  name: string; // unique per (ownerId, kind)
  kind: CredentialKind;
  secret: CredentialSecret;
  isActive: boolean;
}

// =============================================================================
// Consumer reference — what a configuration drives
// =============================================================================

/** The two consumer families today: AI agents and compute providers. */
export type ConsumerKind = 'agent' | 'compute';

/**
 * Identifies the concrete consumer a configuration targets. This is where the
 * agentType/provider binding lives — on the configuration, not the credential.
 */
export type ConsumerRef =
  | { kind: 'agent'; agentType: string } // 'claude-code' | 'openai-codex' | 'opencode' | ...
  | { kind: 'compute'; provider: string }; // 'hetzner' | 'scaleway' | 'gcp'

/** Stable string key for a consumer ref (used to index attachments/platform defaults). */
export function consumerKey(consumer: ConsumerRef): string {
  return consumer.kind === 'agent'
    ? `agent:${consumer.agentType}`
    : `compute:${consumer.provider}`;
}

// =============================================================================
// Primitive 2 — Configuration (consumer + credential ref + settings)
// =============================================================================

/**
 * A named composition. Binds a consumer to a credential plus consumer-specific
 * settings (model, permission mode, base URL override, ...).
 *
 * `credentialId: null` means "platform-managed" — the SAM proxy / platform
 * credential feeds this consumer (the `sam` provider mode today).
 */
export interface Configuration {
  id: string;
  ownerId: string;
  name: string;
  consumer: ConsumerRef;
  credentialId: string | null;
  settings: ConfigurationSettings;
  isActive: boolean;
}

/** Free-form per-consumer settings. Kept open; concrete consumers narrow it. */
export interface ConfigurationSettings {
  model?: string;
  /** For openai-compatible agents (z.ai): the provider base URL override. */
  baseUrl?: string;
  /** Human label for the opencode provider entry, e.g. "zai". */
  providerName?: string;
  permissionMode?: string;
  [key: string]: unknown;
}

// =============================================================================
// Primitive 3 — Attachment (binds a configuration into a scope)
// =============================================================================

/** Where a configuration is attached. */
export type AttachmentScope =
  | { scope: 'user'; userId: string }
  | { scope: 'project'; userId: string; projectId: string };

export interface Attachment {
  id: string;
  configurationId: string;
  /** Denormalized for fast resolver lookup without joining configurations. */
  consumer: ConsumerRef;
  target: AttachmentScope;
  isActive: boolean;
}

// =============================================================================
// Platform defaults — the lowest-precedence fallback per consumer
// =============================================================================

/**
 * Platform-managed fallback for a consumer. Mirrors today's behavior:
 *  - agents: a platform credential, OR the SAM proxy sentinel (`__platform_proxy__`)
 *  - compute: a platform cloud credential
 */
export type PlatformDefault =
  | { mode: 'credential'; credential: Credential }
  | { mode: 'proxy' }; // SAM AI proxy — no real key injected

// =============================================================================
// Composition snapshot — the queryable boundary the real DB implements
// =============================================================================

/**
 * The full set of composition rows for one user, as the resolver sees them.
 * In production this is materialized by a few indexed D1 queries; the resolver
 * itself is pure over this snapshot (testable without a DB — see parity.test.ts).
 */
export interface CompositionSnapshot {
  credentials: Credential[];
  configurations: Configuration[];
  attachments: Attachment[];
  /** Keyed by `consumerKey(consumer)`. */
  platform: Record<string, PlatformDefault>;
}

/** Context for a single resolution. */
export interface ResolutionContext {
  userId: string;
  projectId?: string;
}

/** Where the resolved configuration/credential came from. */
export type ResolutionSource =
  | 'project-attachment'
  | 'user-attachment'
  | 'platform'
  | 'platform-proxy';

/** The output of the generalized resolver. */
export interface ResolvedEnvironment {
  consumer: ConsumerRef;
  configuration: Configuration | null; // null when platform-only / proxy
  credential: Credential | null; // decrypted; null means platform proxy (no key)
  source: ResolutionSource;
}
