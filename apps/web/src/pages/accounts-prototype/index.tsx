/**
 * PROTOTYPE — unified accounts + defaults for agents and infrastructure.
 *
 * Route: /prototype/accounts (dev-only). Views via query string:
 *   ?view=agents | infra | project | empty
 *   &mode=matrix            → "By project" matrix instead of "By provider"
 *   &connect=<providerId>   → open the connect sheet (&step=1|2|3)
 *
 * Self-contained: no API calls, no auth, mock data only. Must be deleted before
 * any merge to main (see apps/web/.claude/rules/37-prototype-development.md).
 */
import {
  Bell,
  Bot,
  ChevronRight,
  Cloud,
  Github,
  KeyRound,
  LineChart,
  Plus,
  Server,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';

import type { AccountActions } from './account-card';
import { ConnectSheet } from './connect-sheet';
import { CoverageOverview, ProjectMatrix } from './coverage';
import { AgentDefaultsGrid, InfraDefaultsPanel } from './defaults';
import type { Account, ProviderKind } from './mock-data';
import {
  ACCOUNTS,
  AGENT_DEFAULTS,
  DEFAULT_AGENT_ID,
  INFRA_DEFAULTS,
  providersOfKind,
} from './mock-data';
import { ProviderMark, SectionHeader, Segmented } from './primitives';
import { ProjectAccountsView } from './project-view';

type View = 'agents' | 'infra' | 'project' | 'empty';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'agents', label: 'Settings → Agents' },
  { id: 'infra', label: 'Settings → Infrastructure' },
  { id: 'project', label: 'Project → Accounts' },
  { id: 'empty', label: 'First run (empty)' },
];

export function AccountsPrototype() {
  const [params, setParams] = useSearchParams();
  const view = (params.get('view') as View | null) ?? 'agents';
  const [accounts, setAccounts] = useState<Account[]>(() => (view === 'empty' ? [] : ACCOUNTS));
  const [mode, setMode] = useState<'provider' | 'project'>(
    params.get('mode') === 'matrix' ? 'project' : 'provider'
  );
  const [expanded, setExpanded] = useState<string[]>(
    view === 'empty' ? [] : ['anthropic', 'openai', 'hetzner']
  );
  const connect = params.get('connect');
  const step = Number(params.get('step') ?? '1') as 1 | 2 | 3;

  const kind: ProviderKind = view === 'infra' ? 'infra' : 'agent';

  function openConnect(providerId?: string, s: 1 | 2 | 3 = providerId ? 2 : 1) {
    const next = new URLSearchParams(params);
    next.set('connect', providerId ?? 'any');
    next.set('step', String(s));
    setParams(next);
  }
  function closeConnect() {
    const next = new URLSearchParams(params);
    next.delete('connect');
    next.delete('step');
    setParams(next);
  }
  function switchView(v: View) {
    setAccounts(v === 'empty' ? [] : ACCOUNTS);
    setExpanded(v === 'empty' ? [] : ['anthropic', 'openai', 'hetzner']);
    setParams(new URLSearchParams({ view: v }));
  }

  const actions: AccountActions = {
    onMakeDefault: (a) =>
      setAccounts((prev) =>
        prev.map((x) => (x.providerId === a.providerId ? { ...x, isDefault: x.id === a.id } : x))
      ),
    onDisconnect: (a) => setAccounts((prev) => prev.filter((x) => x.id !== a.id)),
    onPin: (a) => openConnect(a.providerId, 3),
  };

  return (
    <div
      style={{ height: '100vh', overflow: 'auto' }}
      className="relative bg-canvas text-fg-primary"
    >
      <PrototypeBar view={view} onSwitch={switchView} />

      {view === 'project' ? (
        <ProjectFrame>
          <ProjectAccountsView
            accounts={accounts}
            openPickerFor={params.get('picker') ?? 'anthropic'}
            onConnect={(id) => openConnect(id)}
          />
        </ProjectFrame>
      ) : (
        <SettingsFrame active={kind}>
          {view === 'empty' && <EmptyHero onConnect={openConnect} />}

          <section className="flex flex-col gap-3">
            <SectionHeader
              eyebrow={kind === 'agent' ? 'Agents' : 'Infrastructure'}
              title={kind === 'agent' ? 'Accounts' : 'Cloud accounts'}
              description={
                kind === 'agent'
                  ? 'Every agent account you’ve connected and which projects use it. Connect as many per provider as you like — work, personal, a client’s.'
                  : 'Every cloud account SAM can start machines in, and which projects bill to it.'
              }
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <Segmented
                    ariaLabel="Group by"
                    value={mode}
                    onChange={setMode}
                    options={[
                      { id: 'provider', label: 'By provider' },
                      { id: 'project', label: 'By project' },
                    ]}
                  />
                  <button
                    type="button"
                    onClick={() => openConnect()}
                    className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border-none bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accent-hover"
                  >
                    <Plus size={14} aria-hidden="true" /> Connect account
                  </button>
                </div>
              }
            />
            {mode === 'provider' ? (
              <CoverageOverview
                kind={kind}
                accounts={accounts}
                expanded={expanded}
                onToggle={(id) =>
                  setExpanded((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                  )
                }
                onConnect={openConnect}
                actions={actions}
              />
            ) : (
              <ProjectMatrix kind={kind} accounts={accounts} />
            )}
            <Legend />
          </section>

          <section className="flex flex-col gap-3">
            <SectionHeader
              eyebrow="Defaults"
              title={kind === 'agent' ? 'How each agent behaves' : 'What new workspaces get'}
              description={
                kind === 'agent'
                  ? 'Set once per agent — it doesn’t matter which account a project runs on.'
                  : 'Set once — it doesn’t matter which cloud account a project bills to.'
              }
            />
            {kind === 'agent' ? (
              <AgentDefaultsGrid
                defaults={AGENT_DEFAULTS}
                accounts={accounts}
                defaultAgentId={DEFAULT_AGENT_ID}
                onConnect={(id) => openConnect(id)}
              />
            ) : (
              <InfraDefaultsPanel initial={INFRA_DEFAULTS} accounts={accounts} />
            )}
          </section>
        </SettingsFrame>
      )}

      {connect && (
        <ConnectSheet
          key={`${connect}-${step}`}
          kind={kind}
          accounts={accounts}
          initialProviderId={connect === 'any' ? undefined : connect}
          initialStep={step}
          projectScopeId={view === 'project' ? 'p-rust' : undefined}
          onClose={closeConnect}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

function PrototypeBar({ view, onSwitch }: { view: View; onSwitch: (v: View) => void }) {
  return (
    <div className="sticky top-0 z-40 flex items-center gap-2 overflow-x-auto border-b border-dashed border-[color-mix(in_srgb,var(--sam-color-purple)_50%,transparent)] bg-[color-mix(in_srgb,var(--sam-color-purple)_10%,var(--sam-color-bg-canvas))] px-3 py-1.5">
      <span className="shrink-0 rounded-sm bg-purple px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-black">
        Prototype
      </span>
      {VIEWS.map((v) => (
        <button
          key={v.id}
          type="button"
          onClick={() => onSwitch(v.id)}
          className={`shrink-0 cursor-pointer rounded-sm border-none px-2 py-1 text-[11px] whitespace-nowrap ${
            view === v.id
              ? 'bg-surface font-semibold text-fg-primary'
              : 'bg-transparent text-fg-muted'
          }`}
        >
          {v.label}
        </button>
      ))}
    </div>
  );
}

const NAV = [
  { id: 'agent', label: 'Agents', icon: Bot },
  { id: 'infra', label: 'Infrastructure', icon: Cloud },
  { id: 'github', label: 'GitHub', icon: Github },
  { id: 'mcp', label: 'MCP servers', icon: Server },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'usage', label: 'Usage', icon: LineChart },
  { id: 'access', label: 'Access tokens', icon: KeyRound },
];

function SettingsFrame({ active, children }: { active: string; children: React.ReactNode }) {
  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl px-4 pb-16 pt-4 md:px-6">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-xs text-fg-muted">
        Home <ChevronRight size={12} aria-hidden="true" />{' '}
        <span className="text-fg-primary">Settings</span>
      </nav>
      <h1 className="m-0 mt-2 text-2xl font-semibold text-fg-primary">Settings</h1>

      <div className="mt-4 grid min-w-0 gap-6 md:grid-cols-[11.5rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="min-w-0">
          <ul className="m-0 flex list-none gap-1 overflow-x-auto p-0 md:sticky md:top-12 md:flex-col md:overflow-visible">
            {NAV.map((n) => {
              const on = n.id === active;
              const Icon = n.icon;
              return (
                <li key={n.id} className="shrink-0">
                  <span
                    className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap ${
                      on ? 'bg-accent-tint font-semibold text-fg-primary' : 'text-fg-muted'
                    }`}
                  >
                    <Icon size={15} aria-hidden="true" />
                    {n.label}
                  </span>
                </li>
              );
            })}
          </ul>
          <p className="m-0 mt-4 hidden rounded-md border border-dashed border-border-default p-2.5 text-[11px] leading-relaxed text-fg-muted md:block">
            Folded in: <em>Cloud Provider</em>, <em>Connections</em> and <em>Advanced</em> now live
            inside Agents and Infrastructure.
          </p>
        </nav>
        <main className="flex min-w-0 flex-col gap-8">{children}</main>
      </div>
    </div>
  );
}

function ProjectFrame({ children }: { children: React.ReactNode }) {
  const tabs = ['General', 'Access', 'Accounts', 'Runtime', 'Deploy'];
  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl px-4 pb-16 pt-4 md:px-6">
      <nav
        aria-label="Breadcrumb"
        className="flex min-w-0 items-center gap-1 text-xs text-fg-muted"
      >
        Projects <ChevronRight size={12} aria-hidden="true" />
        <span className="truncate">🦀 rust-experiments</span>
        <ChevronRight size={12} aria-hidden="true" />{' '}
        <span className="text-fg-primary">Settings</span>
      </nav>
      <h1 className="m-0 mt-2 text-2xl font-semibold text-fg-primary">🦀 rust-experiments</h1>
      <div className="mt-4 flex gap-1 overflow-x-auto border-b border-border-default">
        {tabs.map((t) => (
          <span
            key={t}
            className={`shrink-0 px-3 py-2 text-sm ${
              t === 'Accounts'
                ? 'border-b-2 border-accent font-semibold text-fg-primary'
                : 'text-fg-muted'
            }`}
          >
            {t}
          </span>
        ))}
      </div>
      <div className="mt-5">{children}</div>
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 px-1 text-[11px] text-fg-muted">
      <span>
        <strong className="text-success-fg">★ Default</strong> — used by every project that isn’t
        pinned
      </span>
      <span>
        <strong className="text-info-fg">Pinned</strong> — only the projects you choose
      </span>
      <span>
        <strong className="text-fg-primary">Unattached</strong> — connected but unused
      </span>
      <span>
        <strong className="text-fg-primary">Striped</strong> — SAM’s included allowance / fallback
      </span>
    </div>
  );
}

function EmptyHero({ onConnect }: { onConnect: (providerId?: string) => void }) {
  const agents = providersOfKind('agent');
  return (
    <section className="relative overflow-hidden rounded-xl border border-border-default bg-surface p-5 md:p-6">
      <div className="max-w-xl">
        <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-accent-tint px-2 py-0.5 text-[11px] font-semibold text-accent">
          <Sparkles size={11} aria-hidden="true" /> You’re on SAM credits
        </div>
        <h2 className="m-0 text-xl font-semibold text-fg-primary">Bring your own agent accounts</h2>
        <p className="m-0 mt-1.5 text-sm text-fg-muted">
          Claude and OpenAI already work on SAM’s included allowance. Connect your own subscription
          or API key to use your plan’s limits — add as many accounts per provider as you need.
        </p>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {agents.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => onConnect(p.id)}
            className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-border-default bg-inset p-2.5 text-left hover:border-accent"
          >
            <ProviderMark provider={p} size={30} />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold text-fg-primary">{p.product}</span>
              <span className="truncate text-[11px] text-fg-muted">{p.methods[0]?.title}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
