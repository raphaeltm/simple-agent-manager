import { ShieldCheck, SlidersHorizontal, SquareActivity } from 'lucide-react';

import { mockEvents, mockPolicyAreas, mockProfiles } from './mock-data';

const decisionClasses = {
  allowed: 'text-accent',
  denied: 'text-danger',
  scoped: 'text-info',
} as const;

const statusLabels = {
  inherit: 'Inherit',
  restricted: 'Restricted',
  approval: 'Approval',
} as const;

export function PlatformPolicyPrototype() {
  return (
    <div style={{ height: '100vh', overflow: 'auto' }} className="bg-bg-primary text-fg-primary">
      <main className="mx-auto grid box-border w-full max-w-full gap-4 px-4 py-5 sm:px-6 lg:max-w-6xl lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="grid min-w-0 content-start gap-3">
          <div>
            <h1 className="m-0 text-2xl font-semibold">SAM platform policy</h1>
            <p className="m-0 mt-2 text-sm text-fg-muted">
              Server-enforced controls for platform-managed tools, starting with scoped GitHub CLI
              tokens.
            </p>
          </div>

          <nav
            aria-label="Policy areas"
            className="grid gap-1 rounded-md border border-border-default p-2"
          >
            {mockPolicyAreas.map((item, index) => (
              <div
                key={item.name}
                aria-current={index === 0 ? 'page' : undefined}
                className={`rounded px-3 py-2 text-sm ${index === 0 ? 'bg-surface text-fg-primary' : 'text-fg-muted'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span>{item.name}</span>
                  <span className="text-xs">{item.state}</span>
                </div>
                <p className="m-0 mt-1 text-xs text-fg-muted">{item.note}</p>
              </div>
            ))}
          </nav>
        </aside>

        <section className="grid min-w-0 gap-4">
          <div className="grid min-w-0 gap-3 rounded-md border border-border-default p-4">
            <div className="flex items-start gap-3">
              <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
              <div>
                <h2 className="m-0 text-lg font-semibold">Effective policy preview</h2>
                <p className="m-0 mt-1 text-sm text-fg-muted">
                  Resolution order: platform baseline, project defaults, profile overrides, trigger
                  or task constraints, then session grants.
                </p>
              </div>
            </div>
            <div className="grid min-w-0 gap-2 sm:grid-cols-3">
              {['Repository scoped', 'Profile override', 'GitHub enforced'].map((label) => (
                <div key={label} className="min-w-0 rounded border border-border-default p-3">
                  <div className="text-sm font-medium">{label}</div>
                  <div className="mt-1 text-xs text-fg-muted">
                    Applies before every token mint and refresh.
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid min-w-0 gap-3">
            {mockProfiles.map((profile) => (
              <article
                key={profile.name}
                className="min-w-0 rounded-md border border-border-default p-4"
              >
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="text-sm text-fg-muted">{profile.scope}</div>
                    <h3 className="m-0 mt-1 break-words text-base font-semibold">{profile.name}</h3>
                    <p className="m-0 mt-1 break-words text-sm text-fg-muted">{profile.summary}</p>
                  </div>
                  <span className="w-fit rounded border border-border-default px-2 py-1 text-xs">
                    {statusLabels[profile.status]}
                  </span>
                </div>

                <div className="mt-3 grid min-w-0 gap-2">
                  {profile.permissions.length === 0 ? (
                    <div className="min-w-0 rounded bg-surface px-3 py-2 text-sm text-fg-muted">
                      No profile override. The workspace receives the installation token exactly as
                      GitHub grants it.
                    </div>
                  ) : (
                    profile.permissions.map((permission) => (
                      <div
                        key={`${profile.name}-${permission.name}`}
                        className="grid min-w-0 gap-1 rounded bg-surface px-3 py-2 sm:grid-cols-[150px_140px_minmax(0,1fr)] sm:items-center"
                      >
                        <span className="text-sm font-medium">{permission.name}</span>
                        <span className="text-sm text-fg-primary">{permission.level}</span>
                        <span className="break-words text-xs text-fg-muted">{permission.note}</span>
                      </div>
                    ))
                  )}
                </div>
              </article>
            ))}
          </div>

          <div className="grid min-w-0 gap-3 rounded-md border border-border-default p-4">
            <div className="flex items-center gap-2">
              <SquareActivity className="h-5 w-5 text-info" />
              <h2 className="m-0 text-lg font-semibold">Audit trail</h2>
            </div>
            <div className="grid min-w-0 gap-2">
              {mockEvents.map((event) => (
                <div
                  key={`${event.time}-${event.action}`}
                  className="grid min-w-0 gap-1 rounded bg-surface px-3 py-2 sm:grid-cols-[76px_160px_120px_minmax(0,1fr)] sm:items-start"
                >
                  <span className="text-xs text-fg-muted">{event.time}</span>
                  <span className="text-sm">{event.actor}</span>
                  <span className={`text-sm ${decisionClasses[event.decision]}`}>
                    {event.decision}
                  </span>
                  <span className="text-xs text-fg-muted">
                    {event.action}: {event.detail}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div className="mb-6 flex min-w-0 items-start gap-3 rounded-md border border-border-default p-4">
            <SlidersHorizontal className="mt-0.5 h-5 w-5 shrink-0 text-fg-muted" />
            <p className="m-0 text-sm text-fg-muted">
              The first functional slice lives on agent profiles. Future slices should move shared
              policy resolution into a central evaluator used by MCP tools/list, MCP tools/call, and
              provider-specific token minting.
            </p>
          </div>
        </section>
      </main>
    </div>
  );
}
