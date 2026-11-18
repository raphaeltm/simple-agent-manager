/**
 * Pieces every automation detail page shares: the header with its actions, the attention card,
 * the "when → then" summary, and the delete section. Each kind's page composes these with its
 * own sections (runs, webhook connection, receipt check, run limit).
 */
import { Button } from '@simple-agent-manager/ui';
import { useMutation } from '@tanstack/react-query';
import { Bot, CircleAlert, MessageSquare, TriangleAlert } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { useToast } from '../../hooks/useToast';
import { automationPaths } from '../../lib/automation-routes';
import { formatTimeFromNow } from '../../lib/time-utils';
import { useProjectContext } from '../ProjectContext';
import { type AutomationLookups, useInvalidateAutomation } from './data';
import { errorText, isVersionConflict } from './errors';
import type { Attention, AutomationItem } from './model';
import { Page, PageHeader } from './page';
import { whenLabel } from './time';
import { KindIcon, Panel, PromptText, START_META, StatePill } from './ui';

/**
 * A mutation that reports its outcome in a toast and refreshes every automation read.
 * `beforeRefresh` runs first, so a delete can leave the page before its own record is refetched.
 */
export function useAutomationAction<TArgs = void, TResult = unknown>(
  run: (args: TArgs) => Promise<TResult>,
  messages: { success: string | ((result: TResult) => string); failure: string },
  beforeRefresh?: (result: TResult) => void
) {
  const toast = useToast();
  const invalidate = useInvalidateAutomation();
  return useMutation({
    mutationFn: run,
    onSuccess: async (result) => {
      toast.success(
        typeof messages.success === 'function' ? messages.success(result) : messages.success
      );
      beforeRefresh?.(result);
      await invalidate();
    },
    onError: async (error) => {
      toast.error(errorText(error, messages.failure));
      // A version conflict means the page is showing an old copy: load the latest so a retry
      // sends the current version.
      if (isVersionConflict(error)) await invalidate();
    },
  });
}

/** The page frame for one automation: back link, name, state, actions, then two columns. */
export function DetailLayout({
  item,
  actions,
  main,
  side,
}: {
  item: AutomationItem;
  actions: ReactNode;
  main: ReactNode;
  side: ReactNode;
}) {
  const { projectId } = useProjectContext();
  return (
    <Page wide>
      <div className="flex flex-col gap-4" data-testid="automation-detail-header">
        <PageHeader
          back={{ label: 'Automation', to: automationPaths.overview(projectId) }}
          title={
            <span className="flex items-start gap-3">
              <KindIcon start={item.start} size="lg" />
              <span className="min-w-0">{item.name}</span>
            </span>
          }
        />
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
            <StatePill item={item} always />
            <span>{START_META[item.start].label}</span>
          </div>
          {item.stateNote && <p className="m-0 text-sm text-fg-muted">{item.stateNote}</p>}
        </div>
        {actions}
      </div>
      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-8">
        <div className="flex min-w-0 flex-col gap-6">{main}</div>
        <div className="flex min-w-0 flex-col gap-6">{side}</div>
      </div>
    </Page>
  );
}

/**
 * The action row. On phones the buttons share the width in one row (two or three columns), so
 * they never wrap into a ragged stack; from `sm` up they sit side by side at natural width.
 */
export function ActionBar({ children, count }: { children: ReactNode; count: number }) {
  if (count === 0) return null;
  const columns = count >= 3 ? 'grid-cols-3' : count === 2 ? 'grid-cols-2' : 'grid-cols-1';
  return (
    <div
      className={`grid ${columns} gap-2 sm:flex sm:flex-wrap sm:gap-3 [&>*]:min-w-0`}
      data-testid="automation-actions"
    >
      {children}
    </div>
  );
}

export function AttentionCard({
  attention,
  children,
}: {
  attention: Attention;
  children?: ReactNode;
}) {
  const Icon = attention.tone === 'danger' ? TriangleAlert : CircleAlert;
  return (
    <Panel tone={attention.tone} className="flex gap-3 p-4" label="Needs your attention">
      <Icon
        size={20}
        aria-hidden
        className={`mt-0.5 shrink-0 ${attention.tone === 'danger' ? 'text-danger-fg' : 'text-warning-fg'}`}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="m-0 text-[15px] font-semibold text-fg-primary">{attention.title}</p>
        <p className="m-0 text-sm text-fg-muted [overflow-wrap:anywhere]">{attention.body}</p>
        {children && <div className="mt-2 flex flex-wrap gap-3">{children}</div>}
      </div>
    </Panel>
  );
}

export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">{label}</span>
      <span className="text-[15px] text-fg-primary [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

/** "Next" / "Last ran" / "Result", in the words that fit the item's state. */
export function NextFact({ item }: { item: AutomationItem }) {
  if (item.state === 'paused' || item.state === 'off')
    return (
      <Fact label="Next">Nothing starts while it is {item.state === 'off' ? 'off' : 'paused'}</Fact>
    );
  if (item.nextAt) {
    const zoneHint = item.whenNote && item.kind === 'trigger' ? ' your time' : '';
    return (
      <Fact label={item.kind === 'schedule' ? 'Runs' : 'Next'}>
        {`${whenLabel(item.nextAt)}${zoneHint} (${formatTimeFromNow(item.nextAt)})`}
      </Fact>
    );
  }
  if (item.kind === 'schedule') return <Fact label="Result">{item.stateNote ?? 'Done'}</Fact>;
  if (item.lastRunAt)
    return (
      <Fact label="Last ran">{`${whenLabel(item.lastRunAt)} (${formatTimeFromNow(item.lastRunAt)})`}</Fact>
    );
  return (
    <Fact label="Last ran">
      {item.start === 'schedule' ? 'Not yet' : 'Waiting for the first event'}
    </Fact>
  );
}

/** The "when → then" panel: what starts it, what happens, and the prompt. */
export function WhenAndThen({
  item,
  lookups,
  extra,
}: {
  item: AutomationItem;
  lookups: AutomationLookups;
  /** Rows that belong between "when" and "then" (filters, limits). */
  extra?: ReactNode;
}) {
  const { projectId } = useProjectContext();
  const [full, setFull] = useState(false);
  const { action } = item;
  const long = action.prompt.length > 160 || action.prompt.includes('\n');
  const skill = action.kind === 'start' ? lookups.skillName(action.skillId) : null;
  return (
    <Panel className="flex flex-col gap-5 p-4 md:p-5" label="What it does">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Fact label="When">
          {item.when}
          {item.whenNote ? <span className="text-fg-muted"> · {item.whenNote}</span> : null}
        </Fact>
        <NextFact item={item} />
      </div>
      {extra}
      <div className="flex flex-col gap-2">
        <span className="text-xs font-medium uppercase tracking-wider text-fg-muted">Then</span>
        <div className="flex flex-wrap items-center gap-2 text-[15px] text-fg-primary">
          {action.kind === 'start'
            ? item.kind === 'trigger' &&
              item.start === 'github' &&
              item.trigger.githubConfig?.eventType !== 'push' &&
              item.trigger.githubConfig?.subjectAffinity
              ? 'Continue this automation’s active chat for the issue or PR, or start a new one with'
              : 'Start a new chat with'
            : 'Send a message to'}
          {action.kind === 'start' ? (
            <span className="inline-flex min-h-8 items-center gap-1.5 rounded-full border border-border-default px-3 text-sm">
              <Bot size={14} aria-hidden />
              {lookups.profileName(action.agentProfileId)}
            </span>
          ) : (
            <Link
              to={`/projects/${encodeURIComponent(projectId)}/chat/${encodeURIComponent(action.sessionId)}`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-border-default px-3 text-sm text-fg-primary no-underline hover:bg-surface-hover"
            >
              <MessageSquare size={14} aria-hidden />
              {lookups.chatTitle(action.sessionId)}
            </Link>
          )}
          {skill && <span className="text-[13px] text-fg-muted">using the {skill} skill</span>}
        </div>
        <blockquote className="m-0 rounded-lg border-0 border-l-2 border-solid border-accent bg-inset px-4 py-3">
          <p
            className={`m-0 whitespace-pre-wrap break-words text-sm leading-relaxed text-fg-primary ${full ? '' : 'line-clamp-3'}`}
          >
            <PromptText text={action.prompt} />
          </p>
        </blockquote>
        {long && (
          <button
            type="button"
            onClick={() => setFull((value) => !value)}
            aria-expanded={full}
            className="min-h-11 w-fit cursor-pointer rounded-md bg-transparent px-2 text-sm font-semibold text-accent"
          >
            {full ? 'Show less' : 'Show the whole prompt'}
          </button>
        )}
      </div>
    </Panel>
  );
}

/** The last section of a detail page: one clearly separated destructive action. */
export function DangerSection({
  title,
  description,
  buttonLabel,
  confirmTitle,
  confirmMessage,
  confirmLabel,
  busy,
  onConfirm,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  confirmTitle: string;
  confirmMessage: ReactNode;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Panel className="flex flex-col gap-3 p-4" label={title}>
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-[15px] font-semibold text-fg-primary">{title}</h2>
        <p className="m-0 text-[13px] text-fg-muted">{description}</p>
      </div>
      <Button variant="danger" className="w-fit" onClick={() => setOpen(true)} disabled={busy}>
        {buttonLabel}
      </Button>
      <ConfirmDialog
        isOpen={open}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
        title={confirmTitle}
        message={confirmMessage}
        confirmLabel={confirmLabel}
        loading={busy}
      />
    </Panel>
  );
}

/** Not found or not loadable: say so, and offer the way back. */
export function DetailUnavailable({ what, error }: { what: string; error: unknown }) {
  const { projectId } = useProjectContext();
  return (
    <Page>
      <PageHeader
        back={{ label: 'Automation', to: automationPaths.overview(projectId) }}
        title={`This ${what} is not available`}
        subtitle={errorText(error, 'It may have been deleted, or you may not have access to it.')}
      />
    </Page>
  );
}
