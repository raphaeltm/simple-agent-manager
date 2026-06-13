/**
 * PROTOTYPE (E4) — Composable Credentials & Configurations UI.
 *
 * Self-contained, unauthed (route `/prototype/credentials`). No API calls, no
 * auth. Renders the three-primitive model from the E2 experiment and a live
 * "Resolution Explorer" that mirrors the generalized resolver + assembler:
 *   packages/shared/src/experiments/composable-credentials/{resolver,assemblers}.ts
 *
 * Throwaway design-exploration artifact. NOT for production. Must be removed
 * before any merge to main (route + directory).
 */

import { Card, StatusBadge } from '@simple-agent-manager/ui';
import { useMemo, useState } from 'react';

import {
  KIND_LABELS,
  MOCK_ATTACHMENTS,
  MOCK_CONFIGURATIONS,
  MOCK_CREDENTIALS,
  MOCK_PROJECTS,
  type MockConfiguration,
  type MockCredential,
} from './mock-data';

// ---------------------------------------------------------------------------
// Pure resolver — mirrors resolver.ts (project → user → platform, Rule 28 halt)
// ---------------------------------------------------------------------------

type ResolveSource = 'project-attachment' | 'user-attachment' | 'platform-proxy' | null;

interface ResolveResult {
  source: ResolveSource;
  configuration: MockConfiguration | null;
  credential: MockCredential | null;
  /** Human explanation of the path taken — surfaced in the explorer. */
  trace: string[];
}

function configById(id: string): MockConfiguration | undefined {
  return MOCK_CONFIGURATIONS.find((c) => c.id === id);
}
function credById(id: string | null): MockCredential | null {
  if (id === null) return null;
  return MOCK_CREDENTIALS.find((c) => c.id === id) ?? null;
}

function materialize(cfg: MockConfiguration): { credential: MockCredential | null; ok: boolean } {
  if (!cfg.isActive) return { credential: null, ok: false };
  if (cfg.credentialId === null) return { credential: null, ok: true }; // platform-managed
  const cred = credById(cfg.credentialId);
  if (!cred || !cred.isActive) return { credential: null, ok: false };
  return { credential: cred, ok: true };
}

function resolve(consumer: string, projectId: string | null): ResolveResult {
  const trace: string[] = [];
  const forConsumer = MOCK_ATTACHMENTS.filter(
    (a) => configById(a.configurationId)?.consumer === consumer
  );

  // Tier 1 — project attachment
  if (projectId) {
    const projAtt = forConsumer.find((a) => a.scope === 'project' && a.projectId === projectId);
    if (projAtt) {
      if (!projAtt.isActive) {
        trace.push('Found an INACTIVE project override → HALT (Rule 28). Does NOT fall through.');
        return { source: null, configuration: null, credential: null, trace };
      }
      const cfg = configById(projAtt.configurationId)!;
      const { credential, ok } = materialize(cfg);
      trace.push(`Project override → "${cfg.name}"`);
      if (ok) return { source: 'project-attachment', configuration: cfg, credential, trace };
      trace.push('Project config could not materialize (inactive credential) → unresolved.');
      return { source: null, configuration: null, credential: null, trace };
    }
    trace.push('No project override for this consumer → fall through to user scope.');
  }

  // Tier 2 — user attachment
  const userAtt = forConsumer.find((a) => a.scope === 'user' && a.isActive);
  if (userAtt) {
    const cfg = configById(userAtt.configurationId)!;
    const { credential, ok } = materialize(cfg);
    trace.push(`User default → "${cfg.name}"`);
    if (ok) return { source: 'user-attachment', configuration: cfg, credential, trace };
    trace.push('User config could not materialize → fall through to platform.');
  } else {
    trace.push('No active user default → fall through to platform.');
  }

  // Tier 3 — platform proxy (always available for agents in this mock)
  trace.push('Platform default → SAM proxy (__platform_proxy__ sentinel).');
  return { source: 'platform-proxy', configuration: null, credential: null, trace };
}

// ---------------------------------------------------------------------------
// Assembler preview — mirrors assemblers.ts EnvInjection output
// ---------------------------------------------------------------------------

const API_KEY_ENV: Record<string, string> = {
  'claude-code': 'ANTHROPIC_API_KEY',
  'openai-codex': 'OPENAI_API_KEY',
  'google-gemini': 'GEMINI_API_KEY',
  'mistral-vibe': 'MISTRAL_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  amp: 'AMP_API_KEY',
};

function sanitizeAlias(model: string): string {
  return model.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function assemble(consumer: string, r: ResolveResult): Record<string, string> {
  // Halted resolution (inactive project override, Rule 28) → nothing is
  // assembled. The chain stopped; no environment is injected at all.
  if (r.source === null) return {};
  if (r.source === 'platform-proxy' || !r.credential) {
    return { [API_KEY_ENV[consumer] ?? 'API_KEY']: '__platform_proxy__' };
  }
  const cred = r.credential;
  const settings = r.configuration?.settings ?? {};
  switch (cred.kind) {
    case 'api-key':
      return { [API_KEY_ENV[consumer] ?? 'API_KEY']: cred.masked };
    case 'oauth-token':
      return { CLAUDE_CODE_OAUTH_TOKEN: cred.masked };
    case 'auth-json':
      return { CODEX_AUTH_JSON: cred.masked };
    case 'openai-compatible': {
      const alias = sanitizeAlias(settings.model ?? 'glm-4.6');
      return {
        OPENCODE_API_KEY: cred.masked,
        'opencode.json model': `custom/${alias}`,
        'opencode.json baseURL': settings.baseUrl ?? cred.hint ?? '',
      };
    }
    case 'cloud-provider':
      return { provider: consumer, token: cred.masked };
  }
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function SectionHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-fg-muted">{title}</h2>
      {subtitle && <p className="text-xs text-fg-muted">{subtitle}</p>}
    </div>
  );
}

function KindChip({ kind }: { kind: MockCredential['kind'] }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border-default px-2 py-0.5 text-[0.7rem] font-medium text-fg-muted whitespace-nowrap">
      {KIND_LABELS[kind]}
    </span>
  );
}

function CredentialRow({ cred }: { cred: MockCredential }) {
  const configs = cred.usedBy
    .map((id) => MOCK_CONFIGURATIONS.find((c) => c.id === id)?.name)
    .filter(Boolean) as string[];
  return (
    <div
      className={`flex flex-col gap-2 rounded-md border border-border-default p-3 ${
        cred.isActive ? 'bg-surface' : 'opacity-60'
      }`}
    >
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="text-sm font-semibold text-fg-primary break-words">{cred.name}</span>
          {cred.hint && <span className="text-xs text-fg-muted break-words">{cred.hint}</span>}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <KindChip kind={cred.kind} />
          {!cred.isActive && <StatusBadge status="stopped" label="Inactive" />}
        </div>
      </div>
      <code className="text-xs text-fg-muted font-mono break-all">{cred.masked}</code>
      <div className="text-[0.7rem] text-fg-muted">
        {configs.length === 0 ? (
          <span className="italic">Not used by any configuration yet</span>
        ) : (
          <span>
            Used by {configs.length} configuration{configs.length === 1 ? '' : 's'}:{' '}
            <span className="text-fg-primary">{configs.join(', ')}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function ConfigRow({ cfg }: { cfg: MockConfiguration }) {
  const cred = credById(cfg.credentialId);
  const settingChips = Object.entries(cfg.settings).filter(([, v]) => v);
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-default p-3 bg-surface">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <span className="text-sm font-semibold text-fg-primary break-words min-w-0">{cfg.name}</span>
        <span className="inline-flex items-center rounded-full bg-[var(--sam-status-indigo-bg)] px-2 py-0.5 text-[0.7rem] font-medium text-[var(--sam-status-indigo-fg)] whitespace-nowrap shrink-0">
          {cfg.consumerKind}:{cfg.consumer}
        </span>
      </div>
      <div className="text-xs text-fg-muted">
        Credential:{' '}
        {cred ? (
          <span className="text-fg-primary">{cred.name}</span>
        ) : (
          <span className="italic">Platform-managed (SAM proxy)</span>
        )}
      </div>
      {settingChips.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {settingChips.map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center rounded border border-border-default px-1.5 py-0.5 text-[0.68rem] text-fg-muted font-mono break-all"
            >
              {k}={v}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resolution Explorer
// ---------------------------------------------------------------------------

const CONSUMERS = [
  { label: 'Claude Code', value: 'claude-code' },
  { label: 'Codex', value: 'openai-codex' },
  { label: 'OpenCode', value: 'opencode' },
  { label: 'Mistral Vibe', value: 'mistral-vibe' },
  { label: 'Gemini', value: 'google-gemini' },
];

function ResolutionExplorer() {
  const [consumer, setConsumer] = useState('claude-code');
  const [projectId, setProjectId] = useState<string | null>(null);

  const result = useMemo(() => resolve(consumer, projectId), [consumer, projectId]);
  const env = useMemo(() => assemble(consumer, result), [consumer, result]);

  const sourceBadge =
    result.source === 'project-attachment'
      ? { status: 'running', label: 'Project override' }
      : result.source === 'user-attachment'
        ? { status: 'connected', label: 'User default' }
        : result.source === 'platform-proxy'
          ? { status: 'queued', label: 'Platform proxy' }
          : { status: 'error', label: 'Unresolved (halted)' };

  return (
    <Card variant="glass" className="p-4 flex flex-col gap-4">
      <SectionHeader
        title="Resolution Explorer"
        subtitle="One generalized resolver walks project → user → platform for any consumer. Pick a context."
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:gap-4">
        <label className="flex flex-col gap-1 flex-1 min-w-0">
          <span className="text-xs text-fg-muted">Consumer</span>
          <select
            value={consumer}
            onChange={(e) => setConsumer(e.target.value)}
            className="rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-fg-primary"
          >
            {CONSUMERS.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 flex-1 min-w-0">
          <span className="text-xs text-fg-muted">Context</span>
          <select
            value={projectId ?? ''}
            onChange={(e) => setProjectId(e.target.value || null)}
            className="rounded-md border border-border-default bg-surface px-3 py-2 text-sm text-fg-primary"
          >
            <option value="">User scope (no project)</option>
            {MOCK_PROJECTS.map((p) => (
              <option key={p.id} value={p.id}>
                Project: {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-fg-muted">Resolved source:</span>
        <StatusBadge status={sourceBadge.status} label={sourceBadge.label} />
        {result.configuration && (
          <span className="text-xs text-fg-primary break-words">
            via "{result.configuration.name}"
          </span>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Resolution trace
        </span>
        <ol className="flex flex-col gap-1">
          {result.trace.map((line, i) => (
            <li key={i} className="text-xs text-fg-muted flex gap-2">
              <span className="text-fg-primary font-mono shrink-0">{i + 1}.</span>
              <span className="break-words">{line}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          Assembled environment (vm-agent injection)
        </span>
        <pre className="rounded-md border border-border-default bg-[var(--sam-form-focus-inset)] p-3 text-xs text-fg-primary font-mono overflow-x-auto whitespace-pre-wrap break-all">
          {Object.keys(env).length === 0
            ? '# (resolution halted — nothing injected)'
            : Object.entries(env)
                .map(([k, v]) => `${k}=${v}`)
                .join('\n')}
        </pre>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CredentialsPrototype() {
  const agentConfigs = MOCK_CONFIGURATIONS.filter((c) => c.consumerKind === 'agent');
  const computeConfigs = MOCK_CONFIGURATIONS.filter((c) => c.consumerKind === 'compute');

  return (
    <div style={{ height: '100vh', overflow: 'auto' }} className="bg-base text-fg-primary">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 flex flex-col gap-6">
        <header className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-fg-muted">Prototype · E4</span>
          <h1 className="text-xl font-bold text-fg-primary">Composable Credentials</h1>
          <p className="text-sm text-fg-muted max-w-2xl">
            Three primitives — <strong className="text-fg-primary">Credentials</strong> (named,
            typed, agent-agnostic secrets), <strong className="text-fg-primary">Configurations</strong>{' '}
            (consumer + credential + settings), and{' '}
            <strong className="text-fg-primary">Attachments</strong> (bind a configuration into a
            scope). One OpenAI secret can feed both Codex and OpenCode because the agent binding
            lives on the configuration, not the credential.
          </p>
        </header>

        <ResolutionExplorer />

        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Credential library"
            subtitle="Reusable secrets. A credential is agent-agnostic — the consumer binding lives on configurations."
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {MOCK_CREDENTIALS.map((cred) => (
              <CredentialRow key={cred.id} cred={cred} />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Agent configurations"
            subtitle="Each composes one consumer with a credential (or the platform proxy) and per-consumer settings."
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agentConfigs.map((cfg) => (
              <ConfigRow key={cfg.id} cfg={cfg} />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Compute configurations"
            subtitle="The same resolver handles compute providers — the assembler just emits a provider client config instead of env vars."
          />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {computeConfigs.map((cfg) => (
              <ConfigRow key={cfg.id} cfg={cfg} />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <SectionHeader
            title="Attachments"
            subtitle="User defaults + project overrides. An inactive project override halts resolution (Rule 28)."
          />
          <div className="flex flex-col gap-2">
            {MOCK_ATTACHMENTS.map((att) => {
              const cfg = configById(att.configurationId);
              return (
                <div
                  key={att.id}
                  className={`flex items-center justify-between gap-3 rounded-md border border-border-default p-3 bg-surface flex-wrap ${
                    att.isActive ? '' : 'opacity-60'
                  }`}
                >
                  <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm text-fg-primary break-words">{cfg?.name}</span>
                    <span className="text-xs text-fg-muted">
                      {att.scope === 'user'
                        ? 'User default'
                        : `Project override · ${att.projectName}`}
                    </span>
                  </div>
                  {att.isActive ? (
                    <StatusBadge status="connected" label="Active" />
                  ) : (
                    <StatusBadge status="error" label="Inactive (halts)" />
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <footer className="text-xs text-fg-muted py-4 border-t border-border-default">
          Throwaway prototype for design exploration. Mirrors{' '}
          <code className="font-mono">
            packages/shared/src/experiments/composable-credentials/
          </code>
          .
        </footer>
      </div>
    </div>
  );
}
