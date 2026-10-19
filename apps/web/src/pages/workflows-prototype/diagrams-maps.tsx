/**
 * PROTOTYPE ONLY — site maps for A/B/C with an at-a-glance comparison, and the
 * Mermaid flows (rendered through the real RenderedMarkdown).
 */
import { Bookmark, Play, Plus, Workflow } from 'lucide-react';
import type { ReactNode } from 'react';

import { RenderedMarkdown } from '../../components/MarkdownRenderer';

type Tag = 'saved' | 'runs' | 'steps' | 'start';
const TAG: Record<Tag, { label: string; color: string; icon: ReactNode }> = {
  saved: {
    label: 'Saved workflows',
    color: 'var(--sam-color-fg-muted)',
    icon: <Bookmark size={10} />,
  },
  runs: { label: 'Runs', color: 'var(--sam-color-success)', icon: <Play size={10} /> },
  steps: { label: 'Step chats', color: 'var(--sam-color-info)', icon: <Workflow size={10} /> },
  start: { label: 'Start', color: 'var(--sam-color-warning)', icon: <Plus size={10} /> },
};

function T({ t }: { t: Tag }) {
  const m = TAG[t];
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-px text-[10px] font-semibold whitespace-nowrap"
      style={{
        color: m.color,
        border: `1px solid color-mix(in srgb, ${m.color} 50%, transparent)`,
      }}
    >
      {m.icon}
      {m.label}
    </span>
  );
}

interface Node {
  label: string;
  note?: string;
  isNew?: boolean;
  tags?: Tag[];
  children?: Node[];
}

function Tree({ nodes, depth = 0 }: { nodes: Node[]; depth?: number }) {
  return (
    <ul
      className={`list-none m-0 p-0 flex flex-col gap-1 ${depth > 0 ? 'ml-3 pl-3 border-l border-[var(--sam-color-border-default)]' : ''}`}
    >
      {nodes.map((n) => (
        <li key={n.label}>
          <div
            className="rounded-md px-2 py-1.5"
            style={{
              background: n.isNew
                ? 'color-mix(in srgb, var(--sam-color-accent-primary) 12%, transparent)'
                : 'transparent',
              border: n.isNew
                ? '1px solid color-mix(in srgb, var(--sam-color-accent-primary) 45%, transparent)'
                : '1px solid transparent',
            }}
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`text-xs ${n.isNew ? 'font-semibold text-fg-primary' : 'text-fg-primary'}`}
              >
                {n.label}
              </span>
              {n.tags?.map((t) => (
                <T key={t} t={t} />
              ))}
            </div>
            {n.note && (
              <div className="text-[11px] text-fg-muted leading-snug mt-0.5">{n.note}</div>
            )}
          </div>
          {n.children && <Tree nodes={n.children} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

const MAPS: { letter: string; title: string; recommended?: boolean; nodes: Node[] }[] = [
  {
    letter: 'A',
    title: 'Runs live in Chat',
    nodes: [
      {
        label: 'Chat',
        children: [
          {
            label: 'Run rows in the chat list',
            isNew: true,
            tags: ['runs'],
            note: 'Filter: All · Chats · Runs',
          },
          {
            label: 'Run view in the chat pane',
            isNew: true,
            tags: ['steps'],
            note: 'Step chats open from inside the run',
          },
          { label: 'Composer “Workflow” chip', isNew: true, tags: ['start'] },
        ],
      },
      {
        label: 'Ideas',
        children: [
          {
            label: 'Plans tab',
            isNew: true,
            tags: ['saved'],
            note: 'Saved workflows next to draft tasks',
          },
        ],
      },
      { label: 'Triggers', note: 'Action: start a plan', children: [] },
    ],
  },
  {
    letter: 'B',
    title: 'Workflows area, entered from Chat',
    recommended: true,
    nodes: [
      {
        label: 'Chat',
        children: [
          { label: 'Run card in the chat that started it', isNew: true, tags: ['runs'] },
          {
            label: 'Step chats, flat, “Step 3 of 7”',
            isNew: true,
            tags: ['steps'],
            note: 'Toggle: All chats · Hide step chats',
          },
          { label: 'New chat: “Or start a saved workflow”', isNew: true, tags: ['start'] },
        ],
      },
      {
        label: 'Workflows',
        isNew: true,
        note: 'One project nav item, under Chat',
        children: [
          {
            label: 'Runs tab',
            tags: ['runs'],
            note: 'Needs you · Running · Finished',
            isNew: true,
          },
          {
            label: 'Saved tab',
            tags: ['saved'],
            isNew: true,
            children: [
              {
                label: 'Saved workflow page',
                isNew: true,
                note: 'Steps · blanks · schedule · runs · versions',
              },
              { label: 'Start sheet', isNew: true, tags: ['start'] },
            ],
          },
          { label: 'Run page', isNew: true, note: 'Steps · Graph · Activity · step panel' },
        ],
      },
      { label: 'Triggers', note: 'A schedule is a cron trigger: “start workflow X”' },
      { label: 'Notifications', note: 'Approval needed → run page' },
    ],
  },
  {
    letter: 'C',
    title: 'Runbooks and run timelines',
    nodes: [
      {
        label: 'Chat',
        children: [
          {
            label: 'Run timelines as conversations',
            isNew: true,
            tags: ['runs'],
            note: 'Decisions inline, progress rail',
          },
          { label: 'Step chats open from timeline cards', tags: ['steps'], isNew: true },
        ],
      },
      {
        label: 'Library',
        children: [
          {
            label: 'runbooks/*.md',
            isNew: true,
            tags: ['saved', 'start'],
            note: 'A runnable document; agents can edit it',
          },
        ],
      },
      {
        label: 'Home (all projects)',
        children: [
          {
            label: 'Runs panel',
            isNew: true,
            tags: ['runs'],
            note: 'Mission control across projects',
          },
        ],
      },
    ],
  },
];

const COMPARE: { row: string; a: string; b: string; c: string }[] = [
  {
    row: 'Find a run that needs you',
    a: 'In the chat list, mixed with chats',
    b: 'Runs › Needs you, badge on nav',
    c: 'Chat list or Home',
  },
  {
    row: 'Manage saved workflows',
    a: 'Under Ideas (easy to miss)',
    b: 'Saved tab with versions and schedules',
    c: 'Library files (familiar to agents)',
  },
  {
    row: 'Chat list clutter',
    a: 'Low — steps hidden in runs',
    b: 'Medium — flat steps, toggle to hide',
    c: 'Low — steps hidden in timelines',
  },
  {
    row: 'Runs started by a schedule',
    a: 'Appear as chat rows',
    b: 'Runs tab (no chat needed)',
    c: 'Chat + Home',
  },
  {
    row: 'Graph of dependencies',
    a: 'Cramped in the chat pane',
    b: 'Full run page, desktop graph',
    c: 'Progress rail only',
  },
  { row: 'New navigation', a: 'None', b: 'One project item', c: 'None (uses Library, Home)' },
  {
    row: 'Build on what exists',
    a: 'Chat list + Ideas',
    b: 'New pages, existing components',
    c: 'Library + new timeline view',
  },
];

export function DiagramSitemap() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-3">
        {MAPS.map((m) => (
          <section
            key={m.letter}
            className="rounded-lg border p-3 flex flex-col gap-2 min-w-0"
            style={{
              borderColor: m.recommended
                ? 'var(--sam-color-accent-primary)'
                : 'var(--sam-color-border-default)',
            }}
          >
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-md bg-inset border border-border-default text-xs font-bold flex items-center justify-center">
                {m.letter}
              </span>
              <span className="text-sm font-semibold text-fg-primary flex-1">{m.title}</span>
              {m.recommended && (
                <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-accent text-fg-on-accent">
                  Pick
                </span>
              )}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-fg-muted font-semibold">
              Project · Payments API
            </div>
            <Tree nodes={m.nodes} />
          </section>
        ))}
      </div>
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wider text-fg-muted">
          At a glance
        </h2>
        <div className="overflow-x-auto rounded-lg border border-border-default">
          <table className="w-full text-xs border-collapse min-w-[640px]">
            <thead>
              <tr className="text-left text-fg-muted">
                <th className="px-3 py-2 font-semibold">&nbsp;</th>
                <th className="px-3 py-2 font-semibold">A · in Chat</th>
                <th
                  className="px-3 py-2 font-semibold"
                  style={{ color: 'var(--sam-color-accent-primary)' }}
                >
                  B · Workflows area
                </th>
                <th className="px-3 py-2 font-semibold">C · Runbooks</th>
              </tr>
            </thead>
            <tbody>
              {COMPARE.map((r) => (
                <tr key={r.row} className="border-t border-border-default">
                  <td className="px-3 py-2 text-fg-primary font-medium">{r.row}</td>
                  <td className="px-3 py-2 text-fg-muted">{r.a}</td>
                  <td className="px-3 py-2 text-fg-primary">{r.b}</td>
                  <td className="px-3 py-2 text-fg-muted">{r.c}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

const FLOWS_MD = `### 1 · Four ways a run starts — none of them needs an approval to begin

\`\`\`mermaid
flowchart LR
  you["You: Workflows › Saved › Start"] --> run(("Run"))
  newchat["You: New chat › saved workflow"] --> run
  agent["Your agent in chat: start_workflow_run"] --> run
  cron["Schedule: an ordinary cron trigger"] --> run
  run --> steps["SAM starts each step when the steps before it finish"]
  steps --> out["Done · Needs attention · Cancelled"]
  out -. "one-off worth repeating" .-> save["Save as workflow"]
\`\`\`

### 2 · An agent starts an ad hoc plan, with no approval screen

\`\`\`mermaid
sequenceDiagram
  participant P as Priya
  participant A as Agent in chat
  participant S as SAM
  participant W as Step agents
  P->>A: Compare 4 feature-flag services
  A->>S: start_workflow_run(6 steps)
  S-->>A: Run started (card in chat)
  A-->>P: Started — I will sleep until it is done
  S->>W: Start steps as their turn comes, 2 at once
  W-->>S: Results, or a failure
  S->>P: Notify: a step failed (retry or skip)
  S->>A: Wake when it finishes or needs a decision
  A-->>P: Summary, and offer to save it as a workflow
\`\`\`

### 3 · Moving between saved workflows and runs (Option B)

\`\`\`mermaid
flowchart TB
  nav["Project nav: Workflows"] --> runs["Runs tab"]
  nav --> saved["Saved tab"]
  saved --> wf["Saved workflow page"]
  wf --> start["Start sheet: fill the blanks"]
  start --> runpage["Run page"]
  runs --> runpage
  runpage -- "of 'Code change…' v3" --> wf
  runpage -- "Open chat" --> stepchat["A step's chat"]
  stepchat -- "Open run" --> runpage
  chat["Chat with your agent"] -- "Run card: Open run" --> runpage
  notif["Notification: approval needed"] --> runpage
  runpage -- "Save as workflow" --> wf
\`\`\`

### 4 · Failure, approval and cancel inside a run

\`\`\`mermaid
flowchart LR
  ok["Step done"] --> next["Next steps start"]
  fail["Step failed"] --> kind{"Why?"}
  kind -- "machine lost" --> auto["Retried once automatically"]
  kind -- "agent couldn't finish" --> you{"You decide"}
  you -- "Retry with changes" --> next
  you -- "Skip" --> next
  ap{"Approval step"} -- "Approve" --> next
  ap -- "Reject" --> att["Run needs attention"]
  cancel["Cancel run"] --> push["Running steps push work, then stop"] --> grey["Cancelled, not failed"]
\`\`\`
`;

export function DiagramFlows() {
  return (
    <div className="rounded-lg border border-border-default bg-[color-mix(in_srgb,var(--sam-color-bg-surface)_60%,transparent)]">
      <RenderedMarkdown content={FLOWS_MD} />
    </div>
  );
}

export { FLOWS_MD };
