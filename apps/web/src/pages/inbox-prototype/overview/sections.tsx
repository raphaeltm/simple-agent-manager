/**
 * PROTOTYPE ONLY — the Overview's sections, each built from the production row it would
 * use: inbox rows (this prototype), SessionItem (chat list), ProfileUsageAvatar (the usage
 * ring), NeedsAttention and AutomationRow (the Automation page), IdeaRow (Ideas). Counts are
 * computed from the same data the rows render, never typed in.
 */
import { Pane } from '@simple-agent-manager/ui';
import { ChevronRight, GitMerge } from 'lucide-react';
import type { ReactNode } from 'react';

import { RowLink } from '../../../components/page-kit/ui';
import { ProfileUsageAvatar } from '../../../components/project-chat/profile-picker/ProfileUsageAvatar';
import { nudgeHeadline } from '../../../components/project-chat/profile-picker/ProfileUsageNudge';
import { usageWords } from '../../../components/project-chat/profile-picker/usage';
import type { AutomationLookups } from '../../automation/data';
import { comingUp } from '../../automation/model';
import { AutomationRow, NeedsAttention } from '../../automation/overview-sections';
import { IdeaRow } from '../../ideas/parts';
import { SessionItem } from '../../project-chat/SessionItem';
import type { InboxItem } from '../mock-data';
import { formatAge, toRows } from '../model';
import { EmptyInbox, InboxRow } from '../rows';
import { type Account, IDEAS, type MergedPr, PROJECT_ID, type RunningChat } from './data';

/**
 * The overview shows this many inbox rows, then "All n". Section 11.2 says three, which fits
 * a phone; on desktop three left half the column empty, so it shows five.
 */
const NEEDS_YOU_ROWS = { phone: 3, desktop: 5 } as const;
/** Running now lists this many before "and n more" (disclosed, rule 65). */
const RUNNING_ROWS = 5;

const LOOKUPS = {
  profileName: () => 'Sonnet 5.5 Chat',
  chatTitle: () => 'Ship billing',
} as unknown as AutomationLookups;

/** A section's heading row: title, its count, and the link to the full page. */
export function SectionHead({
  title,
  count,
  action,
  onAction,
  tone,
}: {
  title: string;
  count?: number | string;
  action?: string;
  onAction?: () => void;
  tone?: 'attention';
}) {
  return (
    <div className="flex min-h-10 items-center gap-2 px-1">
      <h2 className="m-0 flex min-w-0 items-center gap-2 text-[15px] font-semibold text-fg-primary">
        {title}
        {count !== undefined && (
          <span
            className={`font-mono text-[13px] font-medium ${tone === 'attention' && count ? 'text-warning-fg' : 'text-fg-muted'}`}
          >
            {count}
          </span>
        )}
      </h2>
      {action && (
        <button
          type="button"
          onClick={onAction}
          className="ml-auto flex min-h-10 shrink-0 cursor-pointer items-center gap-0.5 border-0 bg-transparent px-1 text-[13px] text-fg-muted hover:text-fg-primary"
        >
          {action}
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function Section({
  children,
  className = '',
  label,
}: {
  children: ReactNode;
  className?: string;
  label: string;
}) {
  return (
    <Pane
      as="section"
      aria-label={label}
      className={`flex min-w-0 flex-col rounded-[var(--sam-radius-pane)] px-2 pt-1 pb-2 ${className}`}
    >
      {children}
    </Pane>
  );
}

/** Needs you: the first rows in inbox order, the count, and the way to the full inbox. */
export function NeedsYou({
  items,
  count,
  onOpen,
  onAll,
  children,
  desktop = false,
}: {
  items: InboxItem[];
  count: number;
  desktop?: boolean;
  onOpen: (id: string) => void;
  onAll: () => void;
  /** Variant 2 folds the brief into this pane, under the rows. */
  children?: ReactNode;
}) {
  const rows = toRows(items).slice(0, NEEDS_YOU_ROWS[desktop ? 'desktop' : 'phone']);
  return (
    <Section label="Needs you">
      <SectionHead
        title="Needs you"
        count={count}
        tone="attention"
        action={count > 0 ? `All ${count}` : 'Inbox'}
        onAction={onAll}
      />
      {count === 0 ? (
        <p className="m-0 px-1 pb-2 text-sm text-fg-muted">
          Nothing. Agents file here when they need a decision, a secret or a look.
        </p>
      ) : (
        <ul className="m-0 flex flex-col gap-1 p-0">
          {rows.map((row) => (
            <InboxRow
              key={row.type === 'group' ? row.key : row.item.id}
              row={row}
              onOpen={onOpen}
              showProject={false}
            />
          ))}
        </ul>
      )}
      {children}
    </Section>
  );
}

export { EmptyInbox };

/** Running now: working chats, "Needs input" when an inbox item is why it waits. */
export function RunningNow({
  running,
  onAll,
  onOpen,
}: {
  running: RunningChat[];
  onAll: () => void;
  onOpen: (id: string) => void;
}) {
  const shown = running.slice(0, RUNNING_ROWS);
  const more = running.length - shown.length;
  return (
    <Section label="Running now">
      <SectionHead
        title="Running now"
        count={running.length}
        action={running.length ? 'Chats' : undefined}
        onAction={onAll}
      />
      {running.length === 0 ? (
        <p className="m-0 px-1 pb-2 text-sm text-fg-muted">
          Nothing running. The last chat finished 3h ago.
        </p>
      ) : (
        <div className="flex flex-col">
          {shown.map((chat) => (
            <SessionItem
              key={chat.session.id}
              session={chat.session}
              isSelected={false}
              onSelect={onOpen}
              showOwnership={false}
              lineageText={`${chat.runningMin ? formatAge(chat.runningMin) : 'Just started'} on ${chat.profile}`}
            />
          ))}
          {more > 0 && (
            <button
              type="button"
              onClick={onAll}
              className="min-h-10 cursor-pointer border-0 bg-transparent px-3.5 text-left text-[13px] text-fg-muted"
            >
              and {more} more running
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

/**
 * Budgets: one ring per account the project's profiles run on. Words only for an
 * exception (a window at or below half, as the composer's ring does); urgent ones use the
 * nudge's headline.
 */
export function Budgets({ accounts }: { accounts: Account[] }) {
  const exceptions = accounts
    .map((account) => {
      if (account.usage.urgent) {
        const head = nudgeHeadline(account.usage);
        return {
          account,
          color: head.color,
          text: `${head.headline}${head.when ? ` · ${head.when}` : ''}`,
        };
      }
      const word = usageWords(account.usage)[0];
      return word ? { account, color: word.color, text: word.text } : null;
    })
    .filter((e) => e !== null);
  return (
    <Section label="Budgets">
      <SectionHead title="Budgets" action="Usage" />
      <ul className="m-0 grid grid-cols-3 gap-1 p-0">
        {accounts.map((account) => (
          <li
            key={account.label}
            className="flex min-w-0 list-none flex-col items-center gap-1 px-1 py-1.5 text-center"
          >
            <ProfileUsageAvatar profile={account.profile} usage={account.usage} />
            <span className="w-full truncate text-[13px] font-medium text-fg-primary">
              {account.label}
            </span>
            <span className="w-full truncate text-[11px] text-fg-muted">
              {account.profiles.length === 1
                ? account.profiles[0]
                : `${account.profiles.length} profiles`}
            </span>
          </li>
        ))}
      </ul>
      {exceptions.length > 0 && (
        <ul className="m-0 flex flex-col gap-0.5 px-1 pt-1 pb-1">
          {exceptions.map((e) => (
            <li
              key={e.account.label}
              className="list-none text-[13px] break-words"
              style={{ color: e.color ?? undefined }}
            >
              <span className={e.color ? '' : 'text-fg-secondary'}>
                {e.text} on <span className="font-medium">{e.account.label}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Automations: what is broken first (the Automation page's own panels), then what is next. */
export function Automations({
  total,
  items,
}: {
  total: number;
  items: Parameters<typeof comingUp>[0];
}) {
  const next = comingUp(items, 1);
  const failing = items.filter((i) => i.attention).length;
  return (
    <Section label="Automations">
      <SectionHead
        title="Automations"
        count={failing ? `${failing} of ${total} failing` : total}
        tone={failing ? 'attention' : undefined}
        action="All"
      />
      {/* NeedsAttention brings its own "Needs your attention" heading; this section's heading
          already says what is failing, so the inner one is hidden. Production would export
          the Automation page's AttentionPanel instead. */}
      <div className="flex flex-col gap-2 [&_[data-testid=automation-attention]>div:first-child]:hidden">
        <NeedsAttention items={items} canWrite />
        {next.map((item) => (
          <AutomationRow key={item.id} item={item} lookups={LOOKUPS} />
        ))}
      </div>
    </Section>
  );
}

/** Recently: ideas and merged PRs, three each, newest first. */
export function Recently({ prs }: { prs: MergedPr[] }) {
  return (
    <Section label="Recently">
      <SectionHead title="Recently" action="Ideas" />
      <div className="flex flex-col">
        {IDEAS.map((item) => (
          <IdeaRow key={item.ideaId} item={item} projectId={PROJECT_ID} />
        ))}
        {prs.map((pr) => (
          <RowLink
            key={pr.number}
            to="#"
            leading={
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[var(--sam-status-purple-bg)] text-[var(--sam-status-purple-fg)]">
                <GitMerge size={15} aria-hidden="true" />
              </span>
            }
            title={`#${pr.number} ${pr.title}`}
            subtitle={`Merged ${formatAge(pr.ageMin)} ago · ${pr.chat}`}
          />
        ))}
      </div>
    </Section>
  );
}
