/**
 * Insights · Agent setups (slice S): which profile, skill or model gets this project's work merged
 * without rework, how fast, with how much help, at what token and memory cost. One read
 * (`projectSetups`), cached per project, range and grouping. A range or grouping switch keeps the
 * last numbers on screen until the new ones arrive (`.claude/rules/48`).
 *
 * Suggestions apply through the existing skill update API (`updateSkill`, PATCH skill, which
 * checks the caller may edit the project); there is no parallel write path.
 */
import {
  DEFAULT_INSIGHTS_SETUP_GROUPING,
  type InsightsSetupGrouping,
  type InsightsSetupSuggestion,
  isInsightsSetupGrouping,
  type ProjectSetupsResponse,
} from '@simple-agent-manager/shared';
import { Button, Pane, SegmentedControl } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cpu, Lightbulb } from 'lucide-react';
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

import { LoadError, Loading, Notice } from '../../components/page-kit/page';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useQueryScope } from '../../hooks/useQueryScope';
import { useToast } from '../../hooks/useToast';
import { updateSkill } from '../../lib/api';
import {
  agentQueryKeys,
  insightsQueryKeys,
  projectSetupsQueryOptions,
} from '../../lib/query-options';
import { useProjectContext } from '../ProjectContext';
import { Empty, FlowSection } from './flow-parts';
import { formatPercent } from './format';
import { rangeLabel, useInsightsRange } from './index';
import { CompareBars, formatGb, setupColors, SetupsTable } from './setups-parts';

/** Hoisted on purpose: a stable options array, built once. */
const GROUPING_OPTIONS: Array<{ value: InsightsSetupGrouping; label: string }> = [
  { value: 'profile', label: 'Profile' },
  { value: 'skill', label: 'Skill' },
  { value: 'model', label: 'Model' },
];

/** At most this many setups are compared side by side; the table lists them all. */
const COMPARED_SETUPS = 5;

export function AgentSetupsTab() {
  const { projectId } = useProjectContext();
  const range = useInsightsRange();
  const [params, setParams] = useSearchParams();
  const raw = params.get('groupBy');
  const groupBy: InsightsSetupGrouping = isInsightsSetupGrouping(raw)
    ? raw
    : DEFAULT_INSIGHTS_SETUP_GROUPING;
  const setGroupBy = useCallback(
    (next: InsightsSetupGrouping) =>
      setParams(
        (current) => {
          const updated = new URLSearchParams(current);
          updated.set('groupBy', next);
          return updated;
        },
        { replace: true }
      ),
    [setParams]
  );
  const isMobile = useIsMobile();
  const queryScope = useQueryScope();
  const query = useQuery({
    ...projectSetupsQueryOptions(queryScope, projectId, range, groupBy),
    enabled: Boolean(queryScope && projectId),
  });
  const data = query.data;

  return (
    <div
      className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]"
      data-testid="insights-setups"
    >
      <Pane className="flex min-w-0 flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <p className="m-0 text-[13.5px] text-fg-muted">
          Which setup does this kind of work best, on this repository
        </p>
        <SegmentedControl<InsightsSetupGrouping>
          label="Group by"
          value={groupBy}
          onChange={setGroupBy}
          options={GROUPING_OPTIONS}
          size={isMobile ? 'lg' : 'md'}
          className="w-full sm:w-[260px]"
        />
      </Pane>
      {data ? (
        // Kept on screen while another range or grouping loads; the busy state says it is stale.
        <div className="contents" aria-busy={query.isFetching || undefined}>
          <SetupsBody data={data} projectId={projectId} />
        </div>
      ) : query.isError ? (
        <LoadError what="agent setups" error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Loading label="Loading agent setups…" />
      )}
    </div>
  );
}

export function SetupsBody({
  data,
  projectId,
}: {
  data: ProjectSetupsResponse;
  projectId: string;
}) {
  const colors = useMemo(() => setupColors(data.groups), [data.groups]);
  const compared = useMemo(
    () =>
      data.groups
        .filter((g) => g.owner !== 'none' && g.owner !== 'not_recorded')
        .slice(0, COMPARED_SETUPS),
    [data.groups]
  );
  const runsFailed = data.unavailable.includes('runs');
  const totalRuns = data.groups.reduce((sum, g) => sum + g.runs, 0);

  return (
    <>
      {data.unavailable.length > 0 && (
        <Notice>
          Some numbers could not be loaded:{' '}
          {data.unavailable.map((s) => (s === 'runs' ? 'runs' : 'human nudges')).join(', ')}.
        </Notice>
      )}
      {data.sample.truncated && (
        <Notice>
          Showing the newest {data.sample.runs} runs of this range. An administrator can raise the
          limit (Insights · Agent setups run scan cap).
        </Notice>
      )}

      {data.groups.length === 0 && !runsFailed ? (
        <Pane className="px-5 py-8 text-center" data-testid="insights-setups-empty">
          <h2 className="m-0 text-[15px] font-semibold text-fg-primary">No runs in this range</h2>
          <p className="m-0 mt-1 text-[13.5px] text-fg-muted">
            When agents run tasks in this project, each profile, skill and model they ran with shows
            here with how often its work merged, how long it took and what it used.
          </p>
        </Pane>
      ) : (
        data.groups.length > 0 && (
          <FlowSection
            title="Setups"
            note={`${totalRuns} ${totalRuns === 1 ? 'run' : 'runs'} · ${rangeLabel(data.range)}`}
            testId="insights-section-setups"
          >
            <SetupsTable
              groups={data.groups}
              groupBy={data.groupBy}
              colors={colors}
              minRuns={data.suggestionMinRuns}
            />
          </FlowSection>
        )
      )}

      <div className="grid min-w-0 gap-[var(--sam-space-gutter)] lg:grid-cols-2">
        <FlowSection
          title="Compared"
          note={
            compared.length < data.groups.length && compared.length >= 2
              ? `${compared.length} with the most runs`
              : undefined
          }
          testId="insights-section-setups-compare"
        >
          {runsFailed ? (
            <Empty>Runs could not be loaded.</Empty>
          ) : (
            <CompareBars groups={compared} groupBy={data.groupBy} colors={colors} />
          )}
        </FlowSection>
        <FlowSection
          title="Suggestions"
          note={`from your last ${rangeLabel(data.range)}`}
          testId="insights-section-setups-suggestions"
        >
          <SuggestionList data={data} projectId={projectId} />
        </FlowSection>
      </div>

      <p className="m-0 px-1 text-[12.5px] text-fg-muted">
        Merged without rework: a finished run whose pull request merged with no follow-up pull
        request on the same branch within {data.rework.windowDays} days. Nudges are messages a
        person sent while the run was going. Tokens are as the agent or SAM&rsquo;s AI proxy
        reported them, never estimated.
      </p>
    </>
  );
}

function suggestionText(s: InsightsSetupSuggestion): {
  title: string;
  body: string;
  action: string;
  label: string;
} {
  if (s.kind === 'default_profile') {
    const versus = s.compared.name ?? 'a teammate’s profile';
    return {
      title: `Use ${s.profile.name} for ${s.skill.name}`,
      body: `${formatPercent(s.profile.mergedCleanRate)} of its ${s.profile.runs} runs merged without rework, against ${formatPercent(s.compared.mergedCleanRate)} for ${versus}${s.currentDefault ? ', the current default' : ''} over ${s.compared.runs} runs.`,
      action: 'Make it the default',
      label: `Make ${s.profile.name} the default for ${s.skill.name}`,
    };
  }
  const direction = s.suggestedGb < s.currentGb ? 'peaks' : 'needs';
  return {
    title: `${s.skill.name} asks for ${s.currentGb} GB but ${direction} at ${formatGb(s.p90Bytes)} GB`,
    body: `90th percentile over ${s.runs} runs, highest ${formatGb(s.maxBytes)} GB, ${
      s.oomKills === 0 ? 'no out-of-memory kills' : `${s.oomKills} out-of-memory kills`
    }. Requesting ${s.suggestedGb} GB leaves headroom above the peak.`,
    action: `Request ${s.suggestedGb} GB`,
    label: `Request ${s.suggestedGb} GB for ${s.skill.name}`,
  };
}

function SuggestionList({ data, projectId }: { data: ProjectSetupsResponse; projectId: string }) {
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const queryScope = useQueryScope();
  const toast = useToast();
  const apply = useMutation({
    mutationFn: (s: InsightsSetupSuggestion) =>
      updateSkill(projectId, s.apply.skillId, s.apply.patch),
    onSuccess: (_skill, s) => {
      toast.success(
        `${
          s.kind === 'default_profile'
            ? `${s.profile.name} is now the default for ${s.skill.name}`
            : `${s.skill.name} now requests ${s.suggestedGb} GB`
        }. You can change it back in the skill's settings.`
      );
      // The suggestion disappears once the read sees the skill's new settings, and the skill list
      // the task form reads picks up the new default or request.
      void queryClient.invalidateQueries({
        queryKey: insightsQueryKeys.setupsOfProject(queryScope, projectId),
      });
      void queryClient.invalidateQueries({
        queryKey: agentQueryKeys.skillList(queryScope, projectId),
      });
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not update the skill');
    },
  });

  if (data.suggestions.length === 0) {
    return (
      <Empty>
        No suggestions for this range. SAM suggests a change to a skill once each setup it compares
        has at least {data.suggestionMinRuns} finished runs and the difference is clear.
      </Empty>
    );
  }
  return (
    <ul
      className="m-0 flex list-none flex-col gap-0 p-0"
      data-testid="insights-setups-suggestion-list"
    >
      {data.suggestions.map((s) => {
        const text = suggestionText(s);
        const Icon = s.kind === 'default_profile' ? Lightbulb : Cpu;
        const pending = apply.isPending && apply.variables?.id === s.id;
        return (
          <li
            key={s.id}
            className="flex min-w-0 gap-3 border-t border-[var(--sam-hairline)] py-3 first:border-t-0 first:pt-0"
            data-testid="insights-setups-suggestion"
          >
            <span
              aria-hidden="true"
              className="sam-raised grid size-8 shrink-0 place-items-center rounded-[var(--sam-radius-control)] text-[var(--sam-status-success-fg)]"
            >
              <Icon size={16} strokeWidth={1.75} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <h3 className="m-0 text-[14px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
                {text.title}
              </h3>
              <p className="m-0 text-[13px] text-fg-muted [overflow-wrap:anywhere]">{text.body}</p>
              <div>
                <Button
                  variant="raised"
                  // 44px on a phone (SAM Glass touch targets), compact on desktop.
                  size={isMobile ? 'md' : 'sm'}
                  loading={pending}
                  disabled={apply.isPending}
                  onClick={() => apply.mutate(s)}
                  aria-label={text.label}
                >
                  {text.action}
                </Button>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
