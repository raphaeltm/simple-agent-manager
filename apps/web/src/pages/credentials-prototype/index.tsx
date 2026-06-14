/**
 * PROTOTYPE — Composable Credentials & Configurations UX (rebuild).
 *
 * Self-contained, unauthed (route `/prototype/credentials`). No API calls, no
 * auth. Explores a status-overview-first credentials surface over the
 * three-primitive composable-credentials model, plus a guided (dropdown-only)
 * connect flow and a demoted "advanced" raw-CRUD view.
 *
 * Throwaway design-exploration artifact (Rule 37). NOT for production. Must be
 * removed (route + directory) before any merge to main.
 */

import {
  AlertTriangle,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Cloud,
  KeyRound,
  Plug,
  Server,
  ShieldCheck,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import {
  AGENTS,
  ALL_CONSUMERS,
  assemble,
  AUTH_METHOD_OPTIONS,
  type AuthMethod,
  CLOUD_PROVIDERS,
  type Consumer,
  consumerById,
  detectProvider,
  MOCK_ATTACHMENTS,
  MOCK_CREDENTIALS,
  MOCK_PROJECTS,
  resolve,
  type ResolveResult,
  type Scope,
  TOGGLE_PROJECT,
} from './mock-data';

// ---------------------------------------------------------------------------
// Design tokens (inline so the prototype is self-contained)
// ---------------------------------------------------------------------------

const t = {
  page: 'var(--sam-color-bg-page)',
  surface: 'var(--sam-color-bg-surface)',
  surfaceHover: 'var(--sam-color-bg-surface-hover)',
  inset: 'var(--sam-color-bg-inset)',
  fg: 'var(--sam-color-fg-primary)',
  muted: 'var(--sam-color-fg-muted)',
  border: 'var(--sam-color-border-default)',
  accent: 'var(--sam-color-accent-primary)',
  formBg: 'var(--sam-form-bg)',
  rsm: 'var(--sam-radius-sm)',
  rmd: 'var(--sam-radius-md)',
  rlg: 'var(--sam-radius-lg)',
};

const toneStyles: Record<ResolveResult['tone'], { bg: string; fg: string }> = {
  self: { bg: 'var(--sam-status-success-bg)', fg: 'var(--sam-status-success-fg)' },
  platform: { bg: 'var(--sam-status-purple-bg)', fg: 'var(--sam-status-purple-fg)' },
  default: { bg: 'var(--sam-status-indigo-bg)', fg: 'var(--sam-status-indigo-fg)' },
  halted: { bg: 'var(--sam-status-warning-bg)', fg: 'var(--sam-status-warning-fg)' },
  none: { bg: 'var(--sam-status-muted-bg)', fg: 'var(--sam-status-muted-fg)' },
};

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function Badge({ result }: { result: ResolveResult }) {
  const s = toneStyles[result.tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        backgroundColor: s.bg,
        color: s.fg,
      }}
    >
      {result.tone === 'self' && <Check size={12} />}
      {result.tone === 'platform' && <Sparkles size={12} />}
      {result.tone === 'default' && <Sparkles size={12} />}
      {result.tone === 'halted' && <CircleSlash size={12} />}
      {result.tone === 'none' && <AlertTriangle size={12} />}
      {result.badge}
    </span>
  );
}

function consumerIcon(c: Consumer, size = 18) {
  if (c.kind === 'cloud') return <Server size={size} />;
  return <Boxes size={size} />;
}

function FieldLabel({ children, hint }: { children: ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.fg }}>{children}</div>
      {hint && <div style={{ fontSize: 12, color: t.muted, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function selectStyle(): React.CSSProperties {
  return {
    width: '100%',
    padding: '10px 12px',
    fontSize: 14,
    color: t.fg,
    backgroundColor: t.formBg,
    border: `1px solid ${t.border}`,
    borderRadius: t.rsm,
    appearance: 'none',
  };
}

// ---------------------------------------------------------------------------
// Connections view (status overview first)
// ---------------------------------------------------------------------------

function ConnectionRow({
  consumer,
  scope,
  projectId,
}: {
  consumer: Consumer;
  scope: Scope;
  projectId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const result = useMemo(() => resolve(consumer.id, scope, projectId), [consumer.id, scope, projectId]);
  const env = useMemo(() => assemble(consumer.id, result), [consumer.id, result]);

  return (
    <div style={{ borderBottom: `1px solid ${t.border}` }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          padding: '14px 16px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: t.fg,
        }}
      >
        <span style={{ color: t.muted, display: 'flex', flexShrink: 0 }}>{consumerIcon(consumer)}</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: t.fg }}>{consumer.name}</span>
          <span
            style={{
              display: 'block',
              fontSize: 12,
              color: t.muted,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {result.credential ? result.credential.label : consumer.blurb}
          </span>
        </span>
        <Badge result={result} />
        <span style={{ color: t.muted, display: 'flex', flexShrink: 0 }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </span>
      </button>
      {open && (
        <div style={{ padding: '0 16px 16px 46px' }}>
          <div
            style={{
              backgroundColor: t.inset,
              border: `1px solid ${t.border}`,
              borderRadius: t.rmd,
              padding: 12,
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 600, color: t.muted, marginBottom: 8 }}>
              How this resolves
            </div>
            <ol style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {result.trace.map((line, i) => (
                <li key={i} style={{ fontSize: 12.5, color: t.fg, lineHeight: 1.45 }}>
                  {line}
                </li>
              ))}
            </ol>
            {Object.keys(env).length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: t.muted, marginBottom: 6 }}>
                  Injected at workspace boot
                </div>
                {Object.entries(env).map(([k, v]) => (
                  <div
                    key={k}
                    style={{
                      fontFamily: 'ui-monospace, monospace',
                      fontSize: 12,
                      color: t.fg,
                      background: t.formBg,
                      border: `1px solid ${t.border}`,
                      borderRadius: t.rsm,
                      padding: '6px 8px',
                      marginBottom: 4,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {k}={v}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ConnectionsView({ scope, projectId }: { scope: Scope; projectId: string | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Section title="Agents" icon={<Boxes size={16} />} subtitle="Which model credential each coding agent uses">
        {AGENTS.map((c) => (
          <ConnectionRow key={c.id} consumer={c} scope={scope} projectId={projectId} />
        ))}
      </Section>
      <Section
        title="Cloud providers"
        icon={<Cloud size={16} />}
        subtitle="Bring-your-own-cloud — no SAM fallback"
      >
        {CLOUD_PROVIDERS.map((c) => (
          <ConnectionRow key={c.id} consumer={c} scope={scope} projectId={projectId} />
        ))}
      </Section>
    </div>
  );
}

function Section({
  title,
  subtitle,
  icon,
  children,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        backgroundColor: t.surface,
        border: `1px solid ${t.border}`,
        borderRadius: t.rlg,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '14px 16px', borderBottom: `1px solid ${t.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: t.accent, display: 'flex' }}>{icon}</span>
          <span style={{ fontSize: 15, fontWeight: 700, color: t.fg }}>{title}</span>
        </div>
        {subtitle && <div style={{ fontSize: 12.5, color: t.muted, marginTop: 2 }}>{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Guided connect flow
// ---------------------------------------------------------------------------

function ConnectView() {
  const [method, setMethod] = useState<AuthMethod>('api-key');
  const [secret, setSecret] = useState('');
  const [targetId, setTargetId] = useState<string>('claude-code');
  const [scopeChoice, setScopeChoice] = useState<'all' | 'project'>('all');
  const [projectId, setProjectId] = useState<string>(MOCK_PROJECTS[0]?.id ?? '');
  const [subProvider, setSubProvider] = useState<string>('anthropic');
  const [done, setDone] = useState(false);

  const detection = useMemo(() => detectProvider(secret), [secret]);

  // Auto-detect pre-selects the target, but the dropdown stays editable and we
  // never auto-switch to the billing-affecting SAM mode.
  const effectiveTarget = detection.consumerId ?? targetId;
  const target = consumerById(effectiveTarget);

  if (done) {
    return (
      <div
        style={{
          backgroundColor: t.surface,
          border: `1px solid ${t.border}`,
          borderRadius: t.rlg,
          padding: 24,
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 999,
            margin: '0 auto 12px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'var(--sam-status-success-bg)',
            color: 'var(--sam-status-success-fg)',
          }}
        >
          <Check size={26} />
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: t.fg }}>Connected (pretend!)</div>
        <div style={{ fontSize: 13, color: t.muted, marginTop: 4, marginBottom: 16 }}>
          {target?.name} would now use this credential
          {scopeChoice === 'project' ? ` on ${projectId}` : ' across all your projects'}.
        </div>
        <button onClick={() => { setDone(false); setSecret(''); }} style={primaryBtn()}>
          Connect another
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Step 1 — auth method */}
      <div style={cardStyle()}>
        <FieldLabel>How do you want to authenticate?</FieldLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {AUTH_METHOD_OPTIONS.map((opt) => {
            const selected = method === opt.value;
            return (
              <button
                key={opt.value}
                onClick={() => setMethod(opt.value)}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  textAlign: 'left',
                  padding: 12,
                  borderRadius: t.rmd,
                  cursor: 'pointer',
                  background: selected ? 'var(--sam-color-accent-primary-tint)' : t.formBg,
                  border: `1px solid ${selected ? t.accent : t.border}`,
                  color: t.fg,
                }}
              >
                <span style={{ marginTop: 1, flexShrink: 0, color: selected ? t.accent : t.muted, display: 'flex' }}>
                  {opt.value === 'api-key' && <KeyRound size={16} />}
                  {opt.value === 'subscription' && <ShieldCheck size={16} />}
                  {opt.value === 'sam-platform' && <Sparkles size={16} />}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{opt.label}</span>
                  <span style={{ display: 'block', fontSize: 12.5, color: t.muted, marginTop: 2, lineHeight: 1.4 }}>
                    {opt.explain}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Step 2 — method-specific input */}
      <div style={cardStyle()}>
        {method === 'api-key' && (
          <>
            <FieldLabel hint="We auto-detect the provider from the key — no need to tell us which one.">
              Paste your API key
            </FieldLabel>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="sk-ant-…  /  sk-…  /  hcloud_…"
              style={{
                width: '100%',
                padding: '10px 12px',
                fontSize: 14,
                fontFamily: 'ui-monospace, monospace',
                color: t.fg,
                backgroundColor: t.formBg,
                border: `1px solid ${detection.provider ? t.accent : t.border}`,
                borderRadius: t.rsm,
              }}
            />
            <div
              style={{
                fontSize: 12.5,
                marginTop: 6,
                color: detection.provider ? 'var(--sam-status-success-fg)' : t.muted,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {detection.provider ? <Check size={13} /> : <Plug size={13} />}
              {detection.hint}
            </div>
          </>
        )}
        {method === 'subscription' && (
          <>
            <FieldLabel hint="We'll open the provider's OAuth flow. Your plan's usage applies; SAM doesn't bill you.">
              Connect a subscription
            </FieldLabel>
            <select value={subProvider} onChange={(e) => setSubProvider(e.target.value)} style={selectStyle()}>
              <option value="anthropic">Claude (Pro / Max)</option>
              <option value="openai">ChatGPT (Plus / Pro)</option>
            </select>
            <button style={{ ...primaryBtn(), marginTop: 10, width: '100%' }} disabled>
              Continue with OAuth →
            </button>
          </>
        )}
        {method === 'sam-platform' && (
          <div
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              padding: 12,
              borderRadius: t.rmd,
              background: 'var(--sam-status-purple-bg)',
              color: 'var(--sam-status-purple-fg)',
            }}
          >
            <Sparkles size={16} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ fontSize: 13, lineHeight: 1.45 }}>
              SAM will run the models for you. Usage is metered per token and billed to your SAM
              account. No key to paste — you'll just pick the agent and scope below.
            </div>
          </div>
        )}
      </div>

      {/* Step 3 — target agent (skip for cloud-only) */}
      <div style={cardStyle()}>
        <FieldLabel hint={detection.consumerId ? 'Pre-selected from your key — change it if needed.' : undefined}>
          Which agent is this for?
        </FieldLabel>
        <select
          value={effectiveTarget}
          onChange={(e) => setTargetId(e.target.value)}
          style={selectStyle()}
        >
          <optgroup label="Agents">
            {AGENTS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.blurb}
              </option>
            ))}
          </optgroup>
          {method === 'api-key' && (
            <optgroup label="Cloud providers">
              {CLOUD_PROVIDERS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.blurb}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </div>

      {/* Step 4 — scope */}
      <div style={cardStyle()}>
        <FieldLabel>Where should this apply?</FieldLabel>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <ScopeOption
            selected={scopeChoice === 'all'}
            onClick={() => setScopeChoice('all')}
            title="All my projects"
            subtitle="Your default. Any project without its own override uses this."
          />
          <ScopeOption
            selected={scopeChoice === 'project'}
            onClick={() => setScopeChoice('project')}
            title="This project only"
            subtitle="An override for one project. Other projects keep your default."
          />
          {scopeChoice === 'project' && (
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={selectStyle()}>
              {MOCK_PROJECTS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      <button style={{ ...primaryBtn(), width: '100%' }} onClick={() => setDone(true)}>
        Connect {target?.name}
      </button>
    </div>
  );
}

function ScopeOption({
  selected,
  onClick,
  title,
  subtitle,
}: {
  selected: boolean;
  onClick: () => void;
  title: string;
  subtitle: string;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        gap: 10,
        alignItems: 'flex-start',
        textAlign: 'left',
        padding: 12,
        borderRadius: t.rmd,
        cursor: 'pointer',
        background: selected ? 'var(--sam-color-accent-primary-tint)' : t.formBg,
        border: `1px solid ${selected ? t.accent : t.border}`,
        color: t.fg,
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          flexShrink: 0,
          marginTop: 1,
          borderRadius: 999,
          border: `2px solid ${selected ? t.accent : t.muted}`,
          background: selected ? t.accent : 'transparent',
        }}
      />
      <span>
        <span style={{ display: 'block', fontSize: 14, fontWeight: 600 }}>{title}</span>
        <span style={{ display: 'block', fontSize: 12.5, color: t.muted, marginTop: 2 }}>{subtitle}</span>
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Advanced view — raw three-primitive CRUD (demoted)
// ---------------------------------------------------------------------------

function AdvancedView() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'flex-start',
          padding: 12,
          borderRadius: t.rmd,
          background: 'var(--sam-status-info-bg)',
          color: 'var(--sam-status-info-fg)',
        }}
      >
        <Wrench size={16} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ fontSize: 13, lineHeight: 1.45 }}>
          The raw three primitives: <strong>credentials</strong> (secrets),{' '}
          <strong>configurations</strong> (how to use a secret), and <strong>attachments</strong>{' '}
          (where it applies). Most people never need this — use Connections + Connect instead.
        </div>
      </div>

      <Section title="Credentials" subtitle="Stored secrets" icon={<KeyRound size={16} />}>
        {MOCK_CREDENTIALS.map((c) => (
          <div
            key={c.id}
            style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${t.border}` }}
          >
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: 'block', fontSize: 14, color: t.fg }}>{c.label}</span>
              <span style={{ display: 'block', fontSize: 12, color: t.muted, fontFamily: 'ui-monospace, monospace' }}>
                {c.provider} · {c.authMethod} · {c.masked}
              </span>
            </span>
            <span style={{ fontSize: 11, color: c.isActive ? 'var(--sam-status-success-fg)' : 'var(--sam-status-muted-fg)' }}>
              {c.isActive ? 'active' : 'inactive'}
            </span>
          </div>
        ))}
      </Section>

      <Section title="Attachments" subtitle="Bindings that drive resolution" icon={<Plug size={16} />}>
        {MOCK_ATTACHMENTS.map((a) => {
          const consumer = consumerById(a.consumerId);
          const cred = MOCK_CREDENTIALS.find((c) => c.id === a.credentialId);
          return (
            <div
              key={a.id}
              style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${t.border}` }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, color: t.fg }}>
                  {consumer?.name} → {cred ? cred.label : 'SAM platform AI'}
                </span>
                <span style={{ display: 'block', fontSize: 12, color: t.muted }}>
                  scope: {a.scope}
                  {a.projectId ? ` (${a.projectId})` : ''}
                </span>
              </span>
              <span style={{ fontSize: 11, color: a.isActive ? 'var(--sam-status-success-fg)' : 'var(--sam-status-warning-fg)' }}>
                {a.isActive ? 'active' : 'inactive'}
              </span>
            </div>
          );
        })}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared button / card styles
// ---------------------------------------------------------------------------

function primaryBtn(): React.CSSProperties {
  return {
    padding: '11px 18px',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--sam-color-fg-on-accent)',
    background: t.accent,
    border: 'none',
    borderRadius: t.rsm,
    cursor: 'pointer',
  };
}

function cardStyle(): React.CSSProperties {
  return {
    backgroundColor: t.surface,
    border: `1px solid ${t.border}`,
    borderRadius: t.rlg,
    padding: 16,
  };
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

type ViewKey = 'connections' | 'connect' | 'advanced';

export function CredentialsPrototype() {
  const [view, setView] = useState<ViewKey>('connections');
  const [scope, setScope] = useState<Scope>('user');

  const tabs: { key: ViewKey; label: string; icon: ReactNode }[] = [
    { key: 'connections', label: 'Connections', icon: <ShieldCheck size={15} /> },
    { key: 'connect', label: 'Connect', icon: <Plug size={15} /> },
    { key: 'advanced', label: 'Advanced', icon: <Wrench size={15} /> },
  ];

  return (
    <div style={{ height: '100vh', overflow: 'auto', backgroundColor: t.page, color: t.fg }}>
      <div style={{ maxWidth: 720, margin: '0 auto', padding: '20px 16px 64px' }}>
        {/* Header */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <KeyRound size={22} style={{ color: t.accent }} />
            <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0 }}>Credentials</h1>
          </div>
          <p style={{ fontSize: 13.5, color: t.muted, margin: '6px 0 0' }}>
            Connect your AI agents and cloud providers. SAM picks the right credential automatically:
            a project override wins, otherwise your default, otherwise SAM's.
          </p>
        </div>

        {/* Tabs */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: 4,
            backgroundColor: t.surface,
            border: `1px solid ${t.border}`,
            borderRadius: t.rmd,
            marginBottom: 16,
          }}
        >
          {tabs.map((tab) => {
            const active = view === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setView(tab.key)}
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 6,
                  padding: '9px 8px',
                  fontSize: 13,
                  fontWeight: 600,
                  borderRadius: t.rsm,
                  cursor: 'pointer',
                  border: 'none',
                  background: active ? t.accent : 'transparent',
                  color: active ? 'var(--sam-color-fg-on-accent)' : t.muted,
                }}
              >
                {tab.icon}
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Scope toggle — only meaningful for the Connections overview */}
        {view === 'connections' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12.5, color: t.muted }}>Viewing as:</span>
            <div
              style={{
                display: 'inline-flex',
                padding: 3,
                backgroundColor: t.surface,
                border: `1px solid ${t.border}`,
                borderRadius: 999,
              }}
            >
              <ToggleBtn active={scope === 'user'} onClick={() => setScope('user')}>
                My defaults
              </ToggleBtn>
              <ToggleBtn active={scope === 'project'} onClick={() => setScope('project')}>
                {TOGGLE_PROJECT.name}
              </ToggleBtn>
            </div>
            <span style={{ fontSize: 12, color: t.muted }}>
              {scope === 'project'
                ? 'Showing how this project resolves (overrides win).'
                : 'Showing your account-wide defaults.'}
            </span>
          </div>
        )}

        {/* Body */}
        {view === 'connections' && (
          <ConnectionsView scope={scope} projectId={scope === 'project' ? TOGGLE_PROJECT.id : null} />
        )}
        {view === 'connect' && <ConnectView />}
        {view === 'advanced' && <AdvancedView />}
      </div>
    </div>
  );
}

function ToggleBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '5px 14px',
        fontSize: 12.5,
        fontWeight: 600,
        borderRadius: 999,
        cursor: 'pointer',
        border: 'none',
        background: active ? t.accent : 'transparent',
        color: active ? 'var(--sam-color-fg-on-accent)' : t.muted,
        maxWidth: 160,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </button>
  );
}

export default CredentialsPrototype;
