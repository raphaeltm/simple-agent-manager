import type {
  AdminProjectEventInspectorAttempt,
  AdminProjectEventInspectorBatch,
  AdminProjectEventInspectorEvent,
  AdminProjectEventInspectorMatch,
  AdminProjectEventInspectorResponse,
  AdminProjectEventInspectorSubscription,
  AdminProjectEventInspectorTarget,
  ProjectEventFilterV1,
} from '@simple-agent-manager/shared';
import { Button, Caption, Card, EmptyState, Secondary } from '@simple-agent-manager/ui';
import { Clock3, Database, Radio, RefreshCcw, ShieldAlert } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

interface ProjectEventInspectorProps {
  data: AdminProjectEventInspectorResponse;
  isRefreshing?: boolean;
  onRefresh?: () => void;
}

const CLAMPED_TEXT_STYLE: CSSProperties = {
  display: '-webkit-box',
  overflow: 'hidden',
  WebkitBoxOrient: 'vertical',
  WebkitLineClamp: 3,
};

const FILTER_FIELDS: Array<keyof Omit<ProjectEventFilterV1, 'version'>> = [
  'source',
  'eventType',
  'subjectType',
  'subjectId',
  'severity',
];

function humanize(value: string): string {
  return value
    .split('_')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

function formatTime(value: number | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function formatCount(value: number, singular: string, plural = `${singular}s`): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function stateTone(state: string): string {
  switch (state) {
    case 'active':
    case 'delivered':
    case 'acked':
    case 'accepted':
    case 'matched':
    case 'batch_created':
    case 'record_only':
      return 'bg-success-tint text-success-fg';
    case 'pending':
    case 'queued_for_prompt_delivery':
    case 'runtime_steer':
    case 'runtime_interrupt':
    case 'spawn_task':
      return 'bg-info-tint text-info-fg';
    case 'retry':
    case 'ambiguous':
      return 'bg-warning-tint text-warning-fg';
    case 'failed':
    case 'unauthorized':
    case 'unsupported':
    case 'critical':
    case 'error':
      return 'bg-danger-tint text-danger-fg';
    case 'cancelled':
    case 'expired':
    case 'recorded_not_injected':
    default:
      return 'bg-surface-secondary text-fg-muted';
  }
}

function StatePill({ state, label }: { state: string; label?: string }) {
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${stateTone(
        state
      )}`}
    >
      <span aria-hidden>●</span>
      <span className="break-words">{label ?? humanize(state)}</span>
    </span>
  );
}

function IdPill({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null;
  return (
    <span className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-1 rounded-sm border border-border-default bg-inset px-2 py-1 text-xs">
      <span className="shrink-0 font-medium text-fg-muted">{label}</span>
      <span className="min-w-0 break-all font-mono text-fg-primary">{value}</span>
    </span>
  );
}

function MetricCard({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: number;
  detail: string;
  tone?: 'default' | 'attention';
}) {
  return (
    <Card className={`min-w-0 p-4 ${tone === 'attention' && value > 0 ? 'bg-danger-tint' : ''}`}>
      <div className="flex min-w-0 flex-col gap-1">
        <span
          className={`text-2xl font-bold leading-tight ${
            tone === 'attention' && value > 0 ? 'text-danger-fg' : 'text-fg-primary'
          }`}
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {value.toLocaleString()}
        </span>
        <span className="text-sm font-medium text-fg-primary">{label}</span>
        <span className="text-xs text-fg-muted">{detail}</span>
      </div>
    </Card>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0 overflow-hidden">
      <div className="border-b border-border-default px-4 py-3">
        <h2 className="m-0 text-base font-semibold text-fg-primary">{title}</h2>
        {description && <p className="mt-1 text-sm text-fg-muted">{description}</p>}
      </div>
      <div className="min-w-0 p-4">{children}</div>
    </Card>
  );
}

function TargetPills({ target }: { target: AdminProjectEventInspectorTarget }) {
  const hasTarget = target.sessionId || target.taskId || target.runtimeId || target.agentId;
  if (!hasTarget) {
    return <Secondary className="text-sm">No resolved target context.</Secondary>;
  }
  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      <IdPill label="session" value={target.sessionId} />
      <IdPill label="task" value={target.taskId} />
      <IdPill label="agent" value={target.agentId} />
      <IdPill label="runtime" value={target.runtimeId} />
    </div>
  );
}

function FilterSummary({ filter }: { filter: ProjectEventFilterV1 }) {
  const entries = FILTER_FIELDS.flatMap((field) => {
    const value = filter[field];
    if (value === undefined) return [];
    const values = Array.isArray(value) ? value : [value];
    return [{ field, values: values.map(String) }];
  });

  if (entries.length === 0) {
    return <Secondary className="text-sm">Matches all normalized events.</Secondary>;
  }

  return (
    <div className="flex min-w-0 flex-wrap gap-2">
      {entries.map(({ field, values }) => (
        <span
          key={field}
          className="inline-flex min-w-0 max-w-full flex-wrap items-baseline gap-x-1 rounded-sm border border-border-default bg-surface-secondary px-2 py-1 text-xs"
        >
          <span className="shrink-0 font-medium text-fg-muted">{humanize(field)}</span>
          <span className="min-w-0 break-all font-mono text-fg-primary">{values.join(', ')}</span>
        </span>
      ))}
    </div>
  );
}

function SubscriptionCard({
  subscription,
  matches,
  batches,
  attempts,
}: {
  subscription: AdminProjectEventInspectorSubscription;
  matches: AdminProjectEventInspectorMatch[];
  batches: AdminProjectEventInspectorBatch[];
  attempts: AdminProjectEventInspectorAttempt[];
}) {
  const ownerName = subscription.owner.name?.trim();
  const batchIds = new Set(
    batches.filter((batch) => batch.subscriptionId === subscription.id).map((batch) => batch.id)
  );
  const subscriptionMatches = matches.filter((match) => match.subscriptionId === subscription.id);
  const subscriptionBatches = batches.filter((batch) => batch.subscriptionId === subscription.id);
  const subscriptionAttempts = attempts.filter((attempt) => batchIds.has(attempt.batchId));

  return (
    <article className="min-w-0 rounded-lg border border-border-default bg-surface p-4">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <StatePill state={subscription.state} />
              <StatePill
                state={subscription.resolvedDelivery}
                label={humanize(subscription.resolvedDelivery)}
              />
            </div>
            <h3 className="m-0 break-all font-mono text-sm font-semibold text-fg-primary">
              {subscription.id}
            </h3>
          </div>
          <Caption>{formatTime(subscription.updatedAt)}</Caption>
        </div>

        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <div className="min-w-0 rounded-md bg-inset p-3">
            <Caption>Owner</Caption>
            <p className="mt-1 min-w-0 break-words text-sm font-medium text-fg-primary">
              {ownerName || humanize(subscription.owner.type)}
            </p>
            <div className="mt-2 flex min-w-0 flex-wrap gap-2">
              <IdPill label="type" value={subscription.owner.type} />
              <IdPill label="id" value={subscription.owner.id} />
            </div>
          </div>
          <div className="min-w-0 rounded-md bg-inset p-3">
            <Caption>Lifecycle</Caption>
            <dl className="mt-2 grid min-w-0 grid-cols-2 gap-2 text-xs">
              <div className="min-w-0">
                <dt className="text-fg-muted">Created</dt>
                <dd className="m-0 break-words text-fg-primary">
                  {formatTime(subscription.createdAt)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-fg-muted">Expires</dt>
                <dd className="m-0 break-words text-fg-primary">
                  {formatTime(subscription.expiresAt)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-fg-muted">Last match</dt>
                <dd className="m-0 break-words text-fg-primary">
                  {formatTime(subscription.lastMatchedAt)}
                </dd>
              </div>
              <div className="min-w-0">
                <dt className="text-fg-muted">Keys</dt>
                <dd className="m-0 text-fg-primary">{subscription.matchKeyCount}</dd>
              </div>
            </dl>
          </div>
        </div>

        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <div className="min-w-0 rounded-md border border-border-default p-3">
            <Caption>Requested delivery</Caption>
            <div className="mt-2">
              <StatePill state={subscription.requestedDelivery} />
            </div>
          </div>
          <div className="min-w-0 rounded-md border border-border-default p-3">
            <Caption>Resolved delivery</Caption>
            <div className="mt-2">
              <StatePill state={subscription.resolvedDelivery} />
            </div>
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-border-default p-3">
          <Caption>Target context</Caption>
          <div className="mt-2">
            <TargetPills target={subscription.target} />
          </div>
        </div>

        <div className="min-w-0 rounded-md border border-border-default p-3">
          <Caption>Filter</Caption>
          <div className="mt-2">
            <FilterSummary filter={subscription.filter} />
          </div>
        </div>

        {subscription.reason && (
          <p className="min-w-0 break-words rounded-md bg-surface-secondary p-3 text-sm text-fg-muted">
            {subscription.reason}
          </p>
        )}

        <div className="grid min-w-0 gap-2 text-sm sm:grid-cols-3">
          <div className="min-w-0 rounded-md bg-surface-secondary p-3">
            <span className="block font-medium text-fg-primary">
              {formatCount(subscriptionMatches.length, 'match', 'matches')}
            </span>
            <span className="text-xs text-fg-muted">recent lifecycle checks</span>
          </div>
          <div className="min-w-0 rounded-md bg-surface-secondary p-3">
            <span className="block font-medium text-fg-primary">
              {formatCount(subscriptionBatches.length, 'batch', 'batches')}
            </span>
            <span className="text-xs text-fg-muted">delivery batches</span>
          </div>
          <div className="min-w-0 rounded-md bg-surface-secondary p-3">
            <span className="block font-medium text-fg-primary">
              {formatCount(subscriptionAttempts.length, 'attempt', 'attempts')}
            </span>
            <span className="text-xs text-fg-muted">delivery attempts</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function EventCard({ event }: { event: AdminProjectEventInspectorEvent }) {
  const title = event.display.title?.trim() || `${event.source} / ${event.eventType}`;
  const summary = event.display.summary?.trim();

  return (
    <article className="min-w-0 rounded-lg border border-border-default bg-inset p-4">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatePill state={event.severity} />
          <StatePill state={event.state} />
          {event.hasRawPayloadRef && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-secondary px-2.5 py-1 text-xs font-semibold text-fg-muted">
              <Database size={12} aria-hidden />
              raw payload hidden
            </span>
          )}
        </div>
        <div className="min-w-0">
          <h3
            className="m-0 min-w-0 break-words text-sm font-semibold text-fg-primary"
            style={CLAMPED_TEXT_STYLE}
          >
            {title}
          </h3>
          {summary && (
            <p
              className="mt-2 min-w-0 break-words text-sm text-fg-muted"
              style={CLAMPED_TEXT_STYLE}
            >
              {summary}
            </p>
          )}
        </div>
        {event.display.url && (
          <div className="rounded-md border border-warning/30 bg-warning-tint px-3 py-2 text-xs text-warning-fg">
            <span className="font-semibold">Untrusted URL, not linked: </span>
            <span className="break-all font-mono">{event.display.url}</span>
          </div>
        )}
        {event.display.labels && event.display.labels.length > 0 && (
          <div className="flex min-w-0 flex-wrap gap-2">
            {event.display.labels.map((label) => (
              <span
                key={label}
                className="min-w-0 break-all rounded-sm border border-border-default bg-surface px-2 py-1 text-xs text-fg-muted"
              >
                {label}
              </span>
            ))}
          </div>
        )}
        <div className="flex min-w-0 flex-wrap gap-2">
          <IdPill label="event" value={event.id} />
          <IdPill label="source" value={event.source} />
          <IdPill label="type" value={event.eventType} />
          <IdPill label="subject" value={`${event.subject.type}:${event.subject.id}`} />
        </div>
        <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-xs text-fg-muted">
          <span>Occurred {formatTime(event.occurredAt)}</span>
          <span>Received {formatTime(event.receivedAt)}</span>
          <span>{formatCount(event.duplicateCount, 'duplicate')}</span>
          <span>{formatCount(event.conflictCount, 'conflict')}</span>
        </div>
      </div>
    </article>
  );
}

function DeliveryStateList({
  matches,
  batches,
  attempts,
}: {
  matches: AdminProjectEventInspectorMatch[];
  batches: AdminProjectEventInspectorBatch[];
  attempts: AdminProjectEventInspectorAttempt[];
}) {
  if (matches.length === 0 && batches.length === 0 && attempts.length === 0) {
    return <Secondary>No recent matches, batches, or delivery attempts.</Secondary>;
  }

  return (
    <div className="grid min-w-0 gap-4">
      <div className="min-w-0">
        <h3 className="mb-2 text-sm font-semibold text-fg-primary">Matches</h3>
        <div className="space-y-2">
          {matches.map((match) => (
            <div
              key={match.id}
              className="min-w-0 rounded-md border border-border-default bg-surface-secondary p-3"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatePill state={match.state} />
                <Caption>{formatTime(match.matchedAt)}</Caption>
              </div>
              <div className="flex min-w-0 flex-wrap gap-2">
                <IdPill label="match" value={match.id} />
                <IdPill label="event" value={match.eventId} />
                <IdPill label="subscription" value={match.subscriptionId} />
                <IdPill label="batch" value={match.batchId} />
              </div>
              {match.reason && (
                <p className="mt-2 break-words text-xs text-fg-muted">{match.reason}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="min-w-0">
        <h3 className="mb-2 text-sm font-semibold text-fg-primary">Batches</h3>
        <div className="space-y-2">
          {batches.map((batch) => (
            <div
              key={batch.id}
              className="min-w-0 rounded-md border border-border-default bg-surface-secondary p-3"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatePill state={batch.state} />
                <StatePill
                  state={batch.adapterDecision.reason}
                  label={humanize(batch.adapterDecision.reason)}
                />
                <Caption>{formatTime(batch.updatedAt)}</Caption>
              </div>
              <div className="mb-2 grid min-w-0 gap-2 sm:grid-cols-2">
                <div className="min-w-0">
                  <Caption>Requested</Caption>
                  <div className="mt-1">
                    <StatePill state={batch.requestedDelivery} />
                  </div>
                </div>
                <div className="min-w-0">
                  <Caption>Resolved</Caption>
                  <div className="mt-1">
                    <StatePill state={batch.resolvedDelivery} />
                  </div>
                </div>
              </div>
              <div className="flex min-w-0 flex-wrap gap-2">
                <IdPill label="batch" value={batch.id} />
                <IdPill label="subscription" value={batch.subscriptionId} />
                <IdPill label="adapter" value={batch.adapterDecision.adapterId} />
              </div>
              {batch.terminalReason && (
                <p className="mt-2 break-words text-xs text-fg-muted">{batch.terminalReason}</p>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="min-w-0">
        <h3 className="mb-2 text-sm font-semibold text-fg-primary">Attempts</h3>
        <div className="space-y-2">
          {attempts.map((attempt) => (
            <div
              key={attempt.id}
              className="min-w-0 rounded-md border border-border-default bg-surface-secondary p-3"
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <StatePill state={attempt.state} />
                <span className="text-xs text-fg-muted">
                  attempt {attempt.attemptNumber.toLocaleString()}
                </span>
                <Caption>{formatTime(attempt.createdAt)}</Caption>
              </div>
              <div className="flex min-w-0 flex-wrap gap-2">
                <IdPill label="attempt" value={attempt.id} />
                <IdPill label="batch" value={attempt.batchId} />
                <IdPill label="adapter" value={attempt.adapter} />
                <IdPill label="runtime" value={attempt.runtimeId} />
                <IdPill label="receipt" value={attempt.receiptId} />
              </div>
              {(attempt.errorCode || attempt.errorMessage) && (
                <div className="mt-2 rounded-md bg-danger-tint p-2 text-xs text-danger-fg">
                  {attempt.errorCode && (
                    <p className="m-0 break-all font-mono">{attempt.errorCode}</p>
                  )}
                  {attempt.errorMessage && (
                    <p className="m-0 mt-1 break-words">{attempt.errorMessage}</p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AccountingList({
  accounting,
}: {
  accounting: AdminProjectEventInspectorResponse['accounting'];
}) {
  if (accounting.length === 0) {
    return <Secondary>No storage accounting rows have been measured yet.</Secondary>;
  }
  return (
    <div className="grid min-w-0 gap-2">
      {accounting.map((row) => (
        <div
          key={`${row.projectId}:${row.category}`}
          className="grid min-w-0 gap-2 rounded-md border border-border-default bg-surface-secondary p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
        >
          <div className="min-w-0">
            <p className="m-0 break-all font-medium text-fg-primary">{row.category}</p>
            <p className="m-0 text-xs text-fg-muted">Measured {formatTime(row.measuredAt)}</p>
          </div>
          <div className="min-w-0 text-left sm:text-right">
            <p className="m-0 font-medium text-fg-primary">{formatCount(row.recordCount, 'row')}</p>
            <p className="m-0 text-xs text-fg-muted">{formatBytes(row.estimatedBytes)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function ProjectEventInspector({
  data,
  isRefreshing = false,
  onRefresh,
}: ProjectEventInspectorProps) {
  const hasAnyRows =
    data.subscriptions.length > 0 ||
    data.events.length > 0 ||
    data.matches.length > 0 ||
    data.batches.length > 0 ||
    data.attempts.length > 0;

  return (
    <div data-testid="project-event-inspector" className="w-full min-w-0 space-y-4">
      <Card className="min-w-0 overflow-hidden">
        <div className="flex min-w-0 flex-col gap-4 p-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex min-w-0 flex-wrap items-center gap-2">
              <StatePill state={data.project.status ?? 'unknown'} />
              <span className="inline-flex items-center gap-1 rounded-full bg-warning-tint px-2.5 py-1 text-xs font-semibold text-warning-fg">
                <ShieldAlert size={12} aria-hidden />
                internal / superadmin
              </span>
            </div>
            <h1 className="m-0 break-words text-xl font-semibold text-fg-primary">
              {data.project.name}
            </h1>
            <div className="mt-2 flex min-w-0 flex-wrap gap-2">
              <IdPill label="project" value={data.project.id} />
              <IdPill label="repo" value={data.project.repository} />
              <IdPill label="provider" value={data.project.repoProvider} />
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 text-xs text-fg-muted">
              <Clock3 size={13} aria-hidden />
              Generated {formatTime(data.generatedAt)}
            </span>
            {onRefresh && (
              <Button size="sm" variant="secondary" onClick={onRefresh} loading={isRefreshing}>
                <RefreshCcw size={14} aria-hidden />
                Refresh
              </Button>
            )}
          </div>
        </div>
      </Card>

      <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          label="Active subscriptions"
          value={data.totals.activeSubscriptions}
          detail={`${data.totals.terminalSubscriptions.toLocaleString()} terminal in the current result`}
        />
        <MetricCard
          label="Recent events"
          value={data.totals.recentEvents}
          detail={`${data.totals.recentMatches.toLocaleString()} recent matches`}
        />
        <MetricCard
          label="Delivery batches"
          value={data.totals.recentBatches}
          detail={`${data.totals.recentAttempts.toLocaleString()} attempts`}
        />
        <MetricCard
          label="Needs attention"
          value={data.totals.attentionBatches + data.totals.attentionAttempts}
          detail="failed, ambiguous, expired, or retrying delivery state"
          tone="attention"
        />
      </div>

      <div
        role="note"
        className="flex min-w-0 items-start gap-3 rounded-lg border border-warning/30 bg-warning-tint p-4 text-warning-fg"
      >
        <ShieldAlert className="mt-0.5 shrink-0" size={18} aria-hidden />
        <div className="min-w-0">
          <p className="m-0 text-sm font-semibold">Untrusted event content is summarized only.</p>
          <p className="m-0 mt-1 break-words text-sm">
            This inspector renders normalized display titles, summaries, labels, and unlinked URLs
            as escaped text. Raw payloads and metadata are intentionally not returned by the admin
            API.
          </p>
        </div>
      </div>

      {!hasAnyRows ? (
        <EmptyState
          icon={<Radio className="h-full w-full" aria-hidden />}
          heading="No eventing records yet"
          description="This project has no recent normalized events, subscriptions, matches, batches, or attempts in the current result."
        />
      ) : (
        <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
          <div className="min-w-0 space-y-4">
            <SectionCard
              title="Subscriptions"
              description="Owner, lifecycle, requested/resolved delivery, target context, and recent delivery activity."
            >
              {data.subscriptions.length === 0 ? (
                <Secondary>No subscriptions in the current result.</Secondary>
              ) : (
                <div className="space-y-3">
                  {data.subscriptions.map((subscription) => (
                    <SubscriptionCard
                      key={subscription.id}
                      subscription={subscription}
                      matches={data.matches}
                      batches={data.batches}
                      attempts={data.attempts}
                    />
                  ))}
                </div>
              )}
            </SectionCard>

            <SectionCard
              title="Recent normalized events"
              description="Bounded display summaries only. Event URLs are shown as text, not links."
            >
              {data.events.length === 0 ? (
                <Secondary>No recent normalized events in the current result.</Secondary>
              ) : (
                <div className="space-y-3">
                  {data.events.map((event) => (
                    <EventCard key={event.id} event={event} />
                  ))}
                </div>
              )}
            </SectionCard>
          </div>

          <div className="min-w-0 space-y-4">
            <SectionCard
              title="Recent delivery state"
              description="Matches, batches, and attempts from ProjectData's bounded status surface."
            >
              <DeliveryStateList
                matches={data.matches}
                batches={data.batches}
                attempts={data.attempts}
              />
            </SectionCard>

            <SectionCard title="Storage accounting">
              <AccountingList accounting={data.accounting} />
            </SectionCard>

            {data.hasMore && (
              <div
                role="status"
                className="rounded-lg border border-info/30 bg-info-tint p-3 text-sm text-info-fg"
              >
                More eventing records exist beyond this bounded inspector response. Increase the
                request limit or query ProjectData directly for deeper debugging.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
