/**
 * PROTOTYPE ONLY — Option B chat surfaces.
 *  - b/chat            an agent drafts and starts a one-off run with no approval screen
 *  - b/new-chat        new chat offers saved workflows next to starter prompts
 *  - b/step-chat       a step's own chat, flat in the list, with a backlink to its run
 */
import { ArrowUpRight, Bookmark, Workflow } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';

import { useIsMobile } from '../../hooks/useIsMobile';
import { ChatLayout, ChatPane, SessionRows, Transcript, type TranscriptEntry } from './chat-layout';
import {
  RESEARCH_AFTER_START,
  RESEARCH_DONE,
  RESEARCH_NEEDS_ATTENTION,
  RESEARCH_OPENING,
  RESEARCH_RETRIED,
  RESEARCH_SKIPPED,
  STEP_CHAT,
} from './mock-chat';
import { RESEARCH_RUN } from './mock-runs-research';
import { SAVED_WORKFLOWS } from './mock-workflows';
import { CHAT_SESSIONS, NON_STEP_SESSIONS, sessionById, STEP_LINEAGE } from './mock-world';
import { SimulationBar, useRunFrame } from './proto-controls';
import { RunChatCard } from './run-chat-card';
import { p } from './shell';
import { ShapeStrip } from './workflow-cards';

function StepsToggle({ hide, onChange }: { hide: boolean; onChange: (hide: boolean) => void }) {
  return (
    <div
      className="grid grid-cols-2 gap-1 rounded-md border border-border-default bg-surface/40 p-0.5"
      aria-label="Workflow step chats"
    >
      {([false, true] as const).map((v) => (
        <button
          key={String(v)}
          type="button"
          aria-pressed={hide === v}
          onClick={() => onChange(v)}
          className={`rounded-sm px-2 py-1 text-[11px] font-medium transition-colors border-none cursor-pointer ${hide === v ? 'bg-accent/15 text-accent' : 'bg-transparent text-fg-muted hover:text-fg-primary'}`}
        >
          {v ? 'Hide step chats' : 'All chats'}
        </button>
      ))}
    </div>
  );
}

function useRows(selectedId: string) {
  const navigate = useNavigate();
  const [hide, setHide] = useState(false);
  const rows = (
    <SessionRows
      sessions={hide ? NON_STEP_SESSIONS : CHAT_SESSIONS}
      selectedId={selectedId}
      onSelect={(id) => navigate(id === 's-flags-chat' ? p('b/chat') : p('b/step-chat'))}
      lineage={STEP_LINEAGE}
    />
  );
  return { rows, filters: <StepsToggle hide={hide} onChange={setHide} /> };
}

export function ResearchChat() {
  const { frame, goTo } = useRunFrame(RESEARCH_RUN);
  const { rows, filters } = useRows('s-flags-chat');
  const at = RESEARCH_RUN.frames.findIndex((f) => f.id === frame.id);
  const skipped = frame.id === 'flags-skipped';
  const entries: TranscriptEntry[] = [
    ...RESEARCH_OPENING,
    {
      custom: 'run-card',
      node: (
        <RunChatCard
          run={RESEARCH_RUN}
          frame={frame}
          onRetry={() => goTo('flags-4')}
          onSkip={() => goTo('flags-skipped')}
        />
      ),
    },
    ...RESEARCH_AFTER_START,
    ...(at >= 3 ? RESEARCH_NEEDS_ATTENTION : []),
    ...(skipped ? RESEARCH_SKIPPED : at >= 4 ? RESEARCH_RETRIED : []),
    ...(frame.id === 'flags-6' ? RESEARCH_DONE : []),
  ];

  return (
    <ChatLayout
      option="B"
      label="Option B · an agent starts a one-off run from chat"
      rows={rows}
      filters={filters}
      stripExtra={<SimulationBar run={RESEARCH_RUN} />}
    >
      <ChatPane
        session={sessionById('s-flags-chat')}
        sessionState="idle"
        placeholder="Message your agent..."
      >
        <Transcript entries={entries} />
      </ChatPane>
    </ChatLayout>
  );
}

export function StepChat() {
  const { rows, filters } = useRows('s-csv-impl');
  const banner = (
    <div
      className="px-3 py-2 rounded-md border flex items-start gap-2 text-sm bg-info-tint border-info/25"
      role="note"
    >
      <Workflow size={14} className="shrink-0 mt-0.5 text-info" />
      <div className="flex-1 min-w-0">
        <div className="font-medium text-fg-primary text-xs">
          Step 2 of 7 in the run “Fix: CSV export drops the last row”
        </div>
        <div className="text-xs text-fg-muted">
          An ordinary task chat. When it finishes, SAM starts the next steps — you don’t need to do
          anything.
        </div>
      </div>
      <Link
        to={p('b/workflows/runs/run-csv?t=csv-2&step=implement')}
        className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold no-underline"
        style={{ color: 'var(--sam-color-accent-primary)' }}
      >
        Open run <ArrowUpRight size={12} />
      </Link>
    </div>
  );
  return (
    <ChatLayout
      option="B"
      label="Option B · a workflow step’s own chat"
      rows={rows}
      filters={filters}
    >
      <ChatPane
        session={sessionById('s-csv-impl')}
        sessionState="terminated"
        lineageText="Step 2 of 7"
        banner={banner}
        placeholder="Message this step’s agent..."
      >
        <Transcript entries={STEP_CHAT} />
      </ChatPane>
    </ChatLayout>
  );
}

const STARTERS = [
  'Fix the flaky payment-retry test',
  'Add rate limiting to the payouts endpoint',
  'Explain how refunds flow through the ledger',
  'Draft release notes for this week',
];

export function NewChat() {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { rows, filters } = useRows('');
  return (
    <ChatLayout
      option="B"
      label="Option B · new chat offers saved workflows"
      rows={rows}
      filters={filters}
    >
      <div className="flex-1 flex flex-col min-h-0">
        <div
          className={`flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-3 ${isMobile ? 'p-4 justify-start pb-8' : 'p-8 justify-center'}`}
        >
          <span className="text-base font-semibold text-fg-primary">
            What do you want to build?
          </span>
          <span className="sam-type-secondary text-fg-muted text-center max-w-[400px]">
            Describe the task and an agent will start working on it automatically.
          </span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-[560px] mt-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                className="min-h-[44px] rounded-md border border-border-default bg-surface px-3 py-2 text-left text-sm text-fg-primary hover:border-accent hover:bg-accent/5 transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
          <div className="w-full max-w-[560px] mt-3">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-fg-muted whitespace-nowrap">
                Or start a saved workflow
              </span>
              <span className="h-px flex-1 bg-[linear-gradient(90deg,var(--sam-color-border-default),transparent)]" />
              <Link
                to={p('b/workflows/saved')}
                className="text-[11px] text-fg-muted hover:text-fg-primary"
              >
                All
              </Link>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {SAVED_WORKFLOWS.slice(0, 2).map((wf) => (
                <button
                  key={wf.id}
                  type="button"
                  onClick={() => navigate(p(`b/workflows/saved/${wf.id}/start`))}
                  className="min-h-[44px] rounded-md border border-dashed border-[var(--sam-form-border)] bg-transparent px-3 py-2 text-left hover:border-accent/60 transition-colors flex items-center gap-2.5"
                >
                  <Bookmark size={14} className="text-fg-muted shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-fg-primary truncate">{wf.name}</span>
                    <span className="block text-[11px] text-fg-muted">{wf.steps.length} steps</span>
                  </span>
                  <ShapeStrip steps={wf.steps} size={8} />
                </button>
              ))}
            </div>
            <p className="m-0 mt-2 text-[11px] text-fg-muted text-center">
              Or just describe something bigger — the agent can split it into a run of steps.
            </p>
          </div>
        </div>
        <ChatComposerOnly />
      </div>
    </ChatLayout>
  );
}

function ChatComposerOnly() {
  const [v, setV] = useState('');
  return (
    <div className="relative shrink-0 glass-chrome border-x-0 border-b-0 px-4 py-3">
      <div className="flex items-center gap-2">
        <textarea
          value={v}
          onChange={(e) => setV(e.target.value)}
          rows={1}
          placeholder="Describe what you want built..."
          className="flex-1 p-2 px-3 bg-[var(--sam-form-bg)] border border-[rgba(34,197,94,0.12)] rounded-md text-base min-h-[38px] max-h-[120px] text-fg-primary resize-none"
        />
        <button
          type="button"
          disabled={!v}
          className="min-h-[44px] px-4 rounded-md text-white disabled:bg-inset disabled:text-fg-muted disabled:opacity-50 bg-[linear-gradient(135deg,var(--sam-color-accent-primary),#22c55e)]"
        >
          Send
        </button>
      </div>
    </div>
  );
}
