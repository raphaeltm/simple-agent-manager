/**
 * Event-Driven Triggers — UI Prototype
 *
 * Self-contained prototype with mock data for exploring the UX.
 * Not wired to any backend.
 */

import {
  AlertTriangle,
  ArrowLeft,
  Calendar,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Code2,
  ExternalLink,
  Eye,
  Globe,
  Pause,
  Pencil,
  Play,
  Plus,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TriggerStatus = 'active' | 'paused' | 'disabled';
type SourceType = 'cron' | 'webhook' | 'github';
type ExecutionStatus = 'completed' | 'failed' | 'skipped' | 'running' | 'queued';
type SchedulePreset = 'once' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'advanced';
type ScheduleType = 'recurring' | 'once';

type AgentType = 'claude-code' | 'openai-codex' | 'google-gemini' | 'mistral-vibe' | 'opencode';
type VMSize = 'small' | 'medium' | 'large';
type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'dontAsk' | 'bypassPermissions';

interface AgentConfig {
  agentType: AgentType;
  model?: string;
  permissionMode: PermissionMode;
  vmSize: VMSize;
}

interface Trigger {
  id: string;
  name: string;
  description?: string;
  status: TriggerStatus;
  sourceType: SourceType;
  scheduleType: ScheduleType;
  cronExpression?: string;
  cronTimezone?: string;
  scheduledAt?: string; // for one-off triggers
  promptTemplate: string;
  agentProfile?: string;
  agentConfig: AgentConfig;
  skipIfRunning: boolean;
  maxConcurrent: number;
  nextFireAt?: string;
  lastTriggeredAt?: string;
  triggerCount: number;
  stats: { succeeded: number; failed: number; skipped: number };
  consecutiveFailures: number;
  lastError?: string;
}

interface Execution {
  id: string;
  triggerId: string;
  status: ExecutionStatus;
  taskId?: string;
  renderedPrompt: string;
  scheduledAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  sequenceNumber: number;
  skipReason?: string;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_TRIGGERS: Trigger[] = [
  {
    id: 'trig_01',
    name: 'Daily PR Review',
    description: 'Reviews all open pull requests every weekday morning',
    status: 'active',
    sourceType: 'cron',
    scheduleType: 'recurring',
    cronExpression: '0 9 * * 1-5',
    cronTimezone: 'America/New_York',
    promptTemplate:
      'Review all open pull requests on this repository.\n\nCurrent time: {{schedule.timeLocal}}\nDay: {{schedule.dayOfWeek}}\n\nFor each PR, check code quality, test coverage, and potential issues.\nLeave review comments directly on the PRs.',
    agentProfile: 'reviewer',
    agentConfig: { agentType: 'claude-code', model: 'claude-opus-4-6', permissionMode: 'plan', vmSize: 'medium' },
    skipIfRunning: true,
    maxConcurrent: 1,
    nextFireAt: '2026-04-10T13:00:00Z',
    lastTriggeredAt: '2026-04-09T13:00:00Z',
    triggerCount: 47,
    stats: { succeeded: 44, failed: 2, skipped: 1 },
    consecutiveFailures: 0,

  },
  {
    id: 'trig_02',
    name: 'Weekly Dependency Updates',
    description: 'Checks for dependency updates every Friday at 3am',
    status: 'active',
    sourceType: 'cron',
    scheduleType: 'recurring',
    cronExpression: '0 3 * * 5',
    cronTimezone: 'UTC',
    promptTemplate:
      'Check for dependency updates in this repository.\n\nDate: {{schedule.iso}}\n\nFor each outdated dependency:\n1. Check the changelog for breaking changes\n2. If safe, create a PR with the update\n3. If risky, create an issue describing the required changes',
    agentProfile: 'implementer',
    agentConfig: { agentType: 'claude-code', model: 'claude-sonnet-4-5-20250929', permissionMode: 'acceptEdits', vmSize: 'medium' },
    skipIfRunning: true,
    maxConcurrent: 1,
    nextFireAt: '2026-04-11T03:00:00Z',
    lastTriggeredAt: '2026-04-04T03:00:00Z',
    triggerCount: 12,
    stats: { succeeded: 11, failed: 1, skipped: 0 },
    consecutiveFailures: 0,

  },
  {
    id: 'trig_03',
    name: 'Test Suite Monitor',
    description: 'Runs the full test suite every 6 hours and fixes failures',
    status: 'paused',
    sourceType: 'cron',
    scheduleType: 'recurring',
    cronExpression: '0 */6 * * *',
    cronTimezone: 'UTC',
    promptTemplate:
      'Run the full test suite. If any failures, investigate and fix them.\n\nExecution #{{execution.sequenceNumber}}\nTime: {{schedule.time}}',
    agentConfig: { agentType: 'claude-code', model: 'claude-sonnet-4-5-20250929', permissionMode: 'acceptEdits', vmSize: 'small' },
    skipIfRunning: true,
    maxConcurrent: 1,
    lastTriggeredAt: '2026-04-07T18:00:00Z',
    triggerCount: 23,
    stats: { succeeded: 19, failed: 4, skipped: 0 },
    consecutiveFailures: 3,
    lastError: 'No cloud credentials configured',

  },
  {
    id: 'trig_04',
    name: 'Monthly Activity Summary',
    description: 'Generates a summary of all merged PRs and completed tasks',
    status: 'active',
    sourceType: 'cron',
    scheduleType: 'recurring',
    cronExpression: '0 0 1 * *',
    cronTimezone: 'America/New_York',
    promptTemplate:
      'Generate a summary of all merged PRs and completed tasks this month.\n\nMonth: {{schedule.month}} {{schedule.year}}\nProject: {{project.name}}',
    agentProfile: 'planner',
    agentConfig: { agentType: 'claude-code', model: 'claude-opus-4-6', permissionMode: 'plan', vmSize: 'medium' },
    skipIfRunning: false,
    maxConcurrent: 1,
    nextFireAt: '2026-05-01T04:00:00Z',
    lastTriggeredAt: '2026-04-01T04:00:00Z',
    triggerCount: 3,
    stats: { succeeded: 3, failed: 0, skipped: 0 },
    consecutiveFailures: 0,

  },
  {
    id: 'trig_05',
    name: 'Migration dry-run before deploy',
    description: 'Run database migration dry-run Friday evening before Saturday deploy',
    status: 'active',
    sourceType: 'cron',
    scheduleType: 'once',
    scheduledAt: '2026-04-11T22:00:00Z',
    cronTimezone: 'America/New_York',
    promptTemplate:
      'Run a dry-run of the pending database migrations against the staging database.\n\nReport any errors, warnings, or data loss risks.\nDo NOT apply the migration — only validate it.',
    agentConfig: { agentType: 'claude-code', model: 'claude-sonnet-4-5-20250929', permissionMode: 'plan', vmSize: 'medium' },
    skipIfRunning: false,
    maxConcurrent: 1,
    nextFireAt: '2026-04-11T22:00:00Z',
    triggerCount: 0,
    stats: { succeeded: 0, failed: 0, skipped: 0 },
    consecutiveFailures: 0,
  },
  {
    id: 'trig_06',
    name: 'Generate Q1 security audit',
    description: 'One-time security audit of all dependencies and code patterns',
    status: 'disabled',
    sourceType: 'cron',
    scheduleType: 'once',
    scheduledAt: '2026-04-09T06:00:00Z',
    cronTimezone: 'UTC',
    promptTemplate:
      'Perform a comprehensive security audit of this repository.\n\nCheck for:\n- Known vulnerabilities in dependencies\n- OWASP top 10 patterns in the codebase\n- Hardcoded secrets or credentials\n- Outdated TLS/crypto patterns\n\nGenerate a report as a markdown file.',
    agentConfig: { agentType: 'claude-code', model: 'claude-opus-4-6', permissionMode: 'plan', vmSize: 'large' },
    skipIfRunning: false,
    maxConcurrent: 1,
    lastTriggeredAt: '2026-04-09T06:00:00Z',
    triggerCount: 1,
    stats: { succeeded: 1, failed: 0, skipped: 0 },
    consecutiveFailures: 0,
  },
];

const MOCK_EXECUTIONS: Execution[] = [
  {
    id: 'exec_01',
    triggerId: 'trig_01',
    status: 'completed',
    taskId: 'task_abc123',
    renderedPrompt: 'Review all open pull requests...',
    scheduledAt: '2026-04-09T13:00:00Z',
    startedAt: '2026-04-09T13:00:02Z',
    completedAt: '2026-04-09T13:12:34Z',
    durationMs: 752_000,
    sequenceNumber: 47,
  },
  {
    id: 'exec_02',
    triggerId: 'trig_01',
    status: 'completed',
    taskId: 'task_abc122',
    renderedPrompt: 'Review all open pull requests...',
    scheduledAt: '2026-04-08T13:00:00Z',
    startedAt: '2026-04-08T13:00:01Z',
    completedAt: '2026-04-08T13:08:12Z',
    durationMs: 491_000,
    sequenceNumber: 46,
  },
  {
    id: 'exec_03',
    triggerId: 'trig_01',
    status: 'failed',
    taskId: 'task_abc121',
    renderedPrompt: 'Review all open pull requests...',
    scheduledAt: '2026-04-07T13:00:00Z',
    startedAt: '2026-04-07T13:00:03Z',
    completedAt: '2026-04-07T13:02:45Z',
    durationMs: 162_000,
    sequenceNumber: 45,
    errorMessage: 'GitHub API rate limit exceeded',
  },
  {
    id: 'exec_04',
    triggerId: 'trig_01',
    status: 'completed',
    taskId: 'task_abc120',
    renderedPrompt: 'Review all open pull requests...',
    scheduledAt: '2026-04-04T13:00:00Z',
    startedAt: '2026-04-04T13:00:01Z',
    completedAt: '2026-04-04T13:15:02Z',
    durationMs: 901_000,
    sequenceNumber: 44,
  },
  {
    id: 'exec_05',
    triggerId: 'trig_01',
    status: 'skipped',
    renderedPrompt: 'Review all open pull requests...',
    scheduledAt: '2026-04-03T13:00:00Z',
    sequenceNumber: 43,
    skipReason: 'Previous execution still running',
  },
  {
    id: 'exec_06',
    triggerId: 'trig_01',
    status: 'completed',
    taskId: 'task_abc119',
    renderedPrompt: 'Review all open pull requests...',
    scheduledAt: '2026-04-02T13:00:00Z',
    startedAt: '2026-04-02T13:00:02Z',
    completedAt: '2026-04-02T13:10:50Z',
    durationMs: 648_000,
    sequenceNumber: 42,
  },
  {
    id: 'exec_07',
    triggerId: 'trig_01',
    status: 'completed',
    taskId: 'task_abc118',
    renderedPrompt: 'Review all open pull requests...',
    scheduledAt: '2026-04-01T13:00:00Z',
    startedAt: '2026-04-01T13:00:01Z',
    completedAt: '2026-04-01T13:09:30Z',
    durationMs: 569_000,
    sequenceNumber: 41,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function formatDate(dateStr: string, tz?: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: tz,
    timeZoneName: 'short',
  });
}

function cronToHuman(expr: string, tz?: string): string {
  const parts = expr.split(' ');
  if (parts.length !== 5) return expr;
  const [min = '0', hour, dom, , dow] = parts;
  const tzLabel = tz === 'UTC' ? 'UTC' : tz?.split('/').pop()?.replace('_', ' ') ?? '';

  if (expr === '0 */6 * * *') return 'Every 6 hours';
  if (dom !== '*' && dom === '1') return `Monthly on the 1st at ${hour}:${min.padStart(2, '0')} ${tzLabel}`;
  if (dow === '1-5') return `Weekdays at ${hour}:${min.padStart(2, '0')} ${tzLabel}`;
  if (dow === '5') return `Fridays at ${hour}:${min.padStart(2, '0')} ${tzLabel}`;
  if (dow === '1') return `Mondays at ${hour}:${min.padStart(2, '0')} ${tzLabel}`;
  if (dow === '*' && dom === '*') return `Daily at ${hour}:${min.padStart(2, '0')} ${tzLabel}`;
  return expr;
}

function getNextRuns(count: number): string[] {
  const now = new Date();
  const runs: string[] = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(now);
    // Simulate weekday 9am runs
    d.setDate(d.getDate() + i);
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    runs.push(d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
  }
  return runs;
}

// ---------------------------------------------------------------------------
// Status Components
// ---------------------------------------------------------------------------

function StatusDot({ status }: { status: TriggerStatus }) {
  const colors: Record<TriggerStatus, string> = {
    active: 'bg-green-500',
    paused: 'bg-yellow-500',
    disabled: 'bg-gray-500',
  };
  return <span className={`inline-block w-2 h-2 rounded-full ${colors[status]}`} />;
}

function StatusBadge({ status }: { status: TriggerStatus }) {
  const config: Record<TriggerStatus, { bg: string; text: string; label: string }> = {
    active: { bg: 'bg-green-500/15', text: 'text-green-400', label: 'Active' },
    paused: { bg: 'bg-yellow-500/15', text: 'text-yellow-400', label: 'Paused' },
    disabled: { bg: 'bg-gray-500/15', text: 'text-gray-400', label: 'Disabled' },
  };
  const c = config[status];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      <StatusDot status={status} />
      {c.label}
    </span>
  );
}

function ExecutionStatusBadge({ status }: { status: ExecutionStatus }) {
  const config: Record<ExecutionStatus, { bg: string; text: string; label: string }> = {
    completed: { bg: 'bg-green-500/15', text: 'text-green-400', label: 'Completed' },
    failed: { bg: 'bg-red-500/15', text: 'text-red-400', label: 'Failed' },
    skipped: { bg: 'bg-gray-500/15', text: 'text-gray-400', label: 'Skipped' },
    running: { bg: 'bg-blue-500/15', text: 'text-blue-400', label: 'Running' },
    queued: { bg: 'bg-purple-500/15', text: 'text-purple-400', label: 'Queued' },
  };
  const c = config[status];
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${c.bg} ${c.text}`}>
      {c.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

function SuccessRateSparkline({ executions }: { executions: Execution[] }) {
  const recent = executions.slice(0, 20).reverse();
  if (recent.length === 0) return null;
  const barWidth = 6;
  const gap = 2;
  const height = 24;
  const width = recent.length * (barWidth + gap);

  return (
    <svg width={width} height={height} className="inline-block" aria-label="Recent execution results">
      {recent.map((exec, i) => {
        const color =
          exec.status === 'completed'
            ? '#22c55e'
            : exec.status === 'failed'
              ? '#ef4444'
              : '#6b7280';
        return (
          <rect
            key={exec.id}
            x={i * (barWidth + gap)}
            y={exec.status === 'skipped' ? height - 8 : 0}
            width={barWidth}
            height={exec.status === 'skipped' ? 8 : height}
            rx={1}
            fill={color}
            opacity={0.85}
          />
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Trigger Card
// ---------------------------------------------------------------------------

function TriggerCard({
  trigger,
  onSelect,
  onToggleStatus,
  onRunNow,
}: {
  trigger: Trigger;
  onSelect: () => void;
  onToggleStatus: () => void;
  onRunNow: () => void;
}) {
  const executions = MOCK_EXECUTIONS.filter((e) => e.triggerId === trigger.id);
  const successRate =
    trigger.stats.succeeded + trigger.stats.failed > 0
      ? Math.round((trigger.stats.succeeded / (trigger.stats.succeeded + trigger.stats.failed)) * 100)
      : 100;

  return (
    <article className="border border-border-default rounded-lg bg-surface hover:bg-surface-hover/50 transition-colors duration-150">
      {/* Header */}
      <div className="p-4 cursor-pointer" onClick={onSelect} role="button" tabIndex={0}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="shrink-0 w-8 h-8 rounded-md bg-accent/10 flex items-center justify-center">
              {trigger.scheduleType === 'once' && <Calendar size={16} className="text-accent" />}
              {trigger.scheduleType === 'recurring' && trigger.sourceType === 'cron' && <Clock size={16} className="text-accent" />}
              {trigger.sourceType === 'webhook' && <Zap size={16} className="text-accent" />}
              {trigger.sourceType === 'github' && <Code2 size={16} className="text-accent" />}
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-fg-primary truncate">{trigger.name}</h3>
              <p className="text-xs text-fg-muted mt-0.5">
                {trigger.scheduleType === 'once'
                  ? `Once · ${trigger.scheduledAt ? formatDate(trigger.scheduledAt, trigger.cronTimezone) : 'not scheduled'}`
                  : cronToHuman(trigger.cronExpression ?? '', trigger.cronTimezone)
                }
                {' · '}{AGENT_TYPE_LABELS[trigger.agentConfig.agentType]}
                {trigger.agentProfile && ` · ${trigger.agentProfile}`}
              </p>
            </div>
          </div>
          <StatusBadge status={trigger.status} />
        </div>

        {/* Warning banner for paused triggers */}
        {trigger.status === 'paused' && trigger.consecutiveFailures > 0 && (
          <div className="mt-3 flex items-start gap-2 p-2.5 rounded-md bg-yellow-500/10 border border-yellow-500/20">
            <AlertTriangle size={14} className="text-yellow-400 shrink-0 mt-0.5" />
            <div className="text-xs">
              <p className="text-yellow-400 font-medium">Paused: {trigger.consecutiveFailures} consecutive failures</p>
              {trigger.lastError && <p className="text-fg-muted mt-0.5">Last: {trigger.lastError}</p>}
            </div>
          </div>
        )}

        {/* Stats row */}
        <div className="mt-3 flex items-center gap-4 text-xs text-fg-muted flex-wrap">
          {trigger.nextFireAt && (
            <span className="flex items-center gap-1">
              <Calendar size={12} />
              Next: {formatDate(trigger.nextFireAt, trigger.cronTimezone)}
            </span>
          )}
          {trigger.lastTriggeredAt && (
            <span className="flex items-center gap-1">
              <Check size={12} className="text-green-400" />
              Last: {timeAgo(trigger.lastTriggeredAt)}
            </span>
          )}
        </div>

        <div className="mt-2 flex items-center gap-x-3 gap-y-1 text-xs text-fg-muted flex-wrap">
          <span>{trigger.triggerCount} runs</span>
          <span className="text-green-400">{trigger.stats.succeeded} ok</span>
          {trigger.stats.failed > 0 && <span className="text-red-400">{trigger.stats.failed} failed</span>}
          {trigger.stats.skipped > 0 && <span>{trigger.stats.skipped} skipped</span>}
          <span className="flex items-center gap-2 ml-auto">
            {successRate}%
            <SuccessRateSparkline executions={executions.length > 0 ? executions : generateFakeExecutions(trigger)} />
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="px-4 py-2.5 border-t border-border-default grid grid-cols-2 gap-1.5">
        <button
          onClick={(e) => { e.stopPropagation(); onRunNow(); }}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
        >
          <Play size={12} /> Run Now
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors border border-border-default"
        >
          <Eye size={12} /> History
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onToggleStatus(); }}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors border border-border-default"
        >
          {trigger.status === 'active' ? (
            <><Pause size={12} /> Pause</>
          ) : (
            <><Play size={12} /> Resume</>
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSelect(); }}
          className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-md text-xs font-medium text-fg-muted hover:text-fg-primary hover:bg-surface-hover transition-colors border border-border-default"
        >
          <Pencil size={12} /> Edit
        </button>
      </div>
    </article>
  );
}

// Generate fake sparkline data for triggers without real executions
function generateFakeExecutions(trigger: Trigger): Execution[] {
  const results: Execution[] = [];
  const total = Math.min(trigger.triggerCount, 15);
  for (let i = 0; i < total; i++) {
    const rand = Math.random();
    let status: ExecutionStatus = 'completed';
    if (rand < trigger.stats.failed / trigger.triggerCount) status = 'failed';
    else if (rand < (trigger.stats.failed + trigger.stats.skipped) / trigger.triggerCount) status = 'skipped';
    results.push({
      id: `fake_${i}`,
      triggerId: trigger.id,
      status,
      renderedPrompt: '',
      scheduledAt: new Date(Date.now() - i * 86_400_000).toISOString(),
      sequenceNumber: total - i,
    });
  }
  return results;
}


// ---------------------------------------------------------------------------
// Trigger Detail / History View
// ---------------------------------------------------------------------------

function TriggerDetailView({
  trigger,
  onBack,
  onEdit,
}: {
  trigger: Trigger;
  onBack: () => void;
  onEdit: () => void;
}) {
  const executions = MOCK_EXECUTIONS.filter((e) => e.triggerId === trigger.id);
  // Use fake data if no real executions
  const displayExecutions = executions.length > 0 ? executions : generateFakeExecutions(trigger).slice(0, 10);

  return (
    <div className="grid gap-6">
      {/* Header */}
      <div className="grid gap-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="p-1.5 rounded-md hover:bg-surface-hover transition-colors text-fg-muted hover:text-fg-primary shrink-0"
            aria-label="Back to triggers"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-lg font-semibold text-fg-primary truncate">{trigger.name}</h2>
              <StatusBadge status={trigger.status} />
            </div>
            <p className="text-sm text-fg-muted mt-0.5">{trigger.description}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-fg-on-accent hover:bg-accent/90 transition-colors">
            <Play size={14} /> Run Now
          </button>
          <button
            onClick={onEdit}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium text-fg-muted border border-border-default hover:bg-surface-hover transition-colors"
          >
            <Pencil size={14} /> Edit
          </button>
        </div>
      </div>

      {/* Overview Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="border border-border-default rounded-lg bg-surface p-4">
          <p className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-1">
            {trigger.scheduleType === 'once' ? 'Scheduled For' : 'Schedule'}
          </p>
          {trigger.scheduleType === 'once' ? (
            <>
              <p className="text-sm font-medium text-fg-primary">
                {trigger.scheduledAt
                  ? new Date(trigger.scheduledAt).toLocaleString('en-US', {
                      weekday: 'short', month: 'short', day: 'numeric',
                      hour: 'numeric', minute: '2-digit',
                    })
                  : 'Not scheduled'}
              </p>
              <p className="text-xs text-fg-muted flex items-center gap-1 mt-1">
                <Clock size={11} /> One-off task
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-fg-primary">{cronToHuman(trigger.cronExpression ?? '', trigger.cronTimezone)}</p>
              <p className="text-xs text-fg-muted mt-1 font-mono">{trigger.cronExpression}</p>
            </>
          )}
          <p className="text-xs text-fg-muted flex items-center gap-1 mt-1">
            <Globe size={11} /> {trigger.cronTimezone}
          </p>
        </div>
        <div className="border border-border-default rounded-lg bg-surface p-4">
          <p className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-1">
            {trigger.scheduleType === 'once' ? 'Status' : 'Next Run'}
          </p>
          {trigger.scheduleType === 'once' ? (
            trigger.triggerCount > 0 ? (
              <p className="text-sm font-medium text-green-400">Completed</p>
            ) : trigger.status === 'paused' ? (
              <p className="text-sm text-fg-muted">Paused</p>
            ) : (
              <>
                <p className="text-sm font-medium text-accent">Pending</p>
                {trigger.scheduledAt && (
                  <p className="text-xs text-fg-muted mt-1">{timeAgo(trigger.scheduledAt).replace(' ago', ' from now')}</p>
                )}
              </>
            )
          ) : trigger.nextFireAt ? (
            <>
              <p className="text-sm font-medium text-fg-primary">{formatDate(trigger.nextFireAt, trigger.cronTimezone)}</p>
              <p className="text-xs text-fg-muted mt-1">{timeAgo(trigger.nextFireAt).replace(' ago', ' from now')}</p>
            </>
          ) : (
            <p className="text-sm text-fg-muted">Paused</p>
          )}
        </div>
        <div className="border border-border-default rounded-lg bg-surface p-4">
          <p className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-1">Success Rate</p>
          <div className="flex items-center gap-3">
            <p className="text-2xl font-bold text-fg-primary">
              {trigger.stats.succeeded + trigger.stats.failed > 0
                ? Math.round((trigger.stats.succeeded / (trigger.stats.succeeded + trigger.stats.failed)) * 100)
                : 100}
              %
            </p>
            <SuccessRateSparkline executions={displayExecutions} />
          </div>
          <p className="text-xs text-fg-muted mt-1">
            {trigger.triggerCount} total · {trigger.stats.succeeded} passed · {trigger.stats.failed} failed
          </p>
        </div>
      </div>

      {/* Agent Configuration */}
      <div className="border border-border-default rounded-lg bg-surface">
        <div className="px-4 py-3 border-b border-border-default">
          <h3 className="text-sm font-semibold text-fg-primary">Agent Configuration</h3>
        </div>
        <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-4">
          {trigger.agentProfile && (
            <div className="col-span-2 sm:col-span-4">
              <p className="text-xs text-fg-muted mb-0.5">Profile</p>
              <p className="text-sm font-medium text-accent">{trigger.agentProfile}</p>
            </div>
          )}
          <div>
            <p className="text-xs text-fg-muted mb-0.5">Agent</p>
            <p className="text-sm font-medium text-fg-primary">{AGENT_TYPE_LABELS[trigger.agentConfig.agentType]}</p>
          </div>
          <div>
            <p className="text-xs text-fg-muted mb-0.5">Model</p>
            <p className="text-sm font-medium text-fg-primary font-mono">{trigger.agentConfig.model || 'default'}</p>
          </div>
          <div>
            <p className="text-xs text-fg-muted mb-0.5">Permissions</p>
            <p className="text-sm font-medium text-fg-primary">{PERMISSION_MODE_LABELS[trigger.agentConfig.permissionMode]}</p>
          </div>
          <div>
            <p className="text-xs text-fg-muted mb-0.5">VM Size</p>
            <p className="text-sm font-medium text-fg-primary">{VM_SIZE_LABELS[trigger.agentConfig.vmSize]}</p>
          </div>
        </div>
      </div>

      {/* Prompt Template */}
      <div className="border border-border-default rounded-lg bg-surface">
        <div className="px-4 py-3 border-b border-border-default">
          <h3 className="text-sm font-semibold text-fg-primary">Prompt Template</h3>
        </div>
        <pre className="p-4 text-sm text-fg-primary font-mono whitespace-pre-wrap break-words leading-relaxed">
          {trigger.promptTemplate}
        </pre>
      </div>

      {/* Execution History */}
      <div className="border border-border-default rounded-lg bg-surface">
        <div className="px-4 py-3 border-b border-border-default">
          <h3 className="text-sm font-semibold text-fg-primary">Execution History</h3>
        </div>
        <div className="divide-y divide-border-default">
          {displayExecutions.map((exec) => (
            <div key={exec.id} className="px-4 py-3 hover:bg-surface-hover/50 transition-colors">
              <div className="flex items-start gap-3 flex-wrap">
                <ExecutionStatusBadge status={exec.status} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <span className="text-fg-primary font-medium">#{exec.sequenceNumber}</span>
                    <span className="text-fg-muted text-xs">{formatDate(exec.scheduledAt)}</span>
                  </div>
                  {exec.errorMessage && (
                    <p className="text-xs text-red-400 mt-0.5 break-words">{exec.errorMessage}</p>
                  )}
                  {exec.skipReason && (
                    <p className="text-xs text-fg-muted mt-0.5 break-words">{exec.skipReason}</p>
                  )}
                </div>
                <div className="text-right shrink-0">
                  {exec.durationMs && (
                    <span className="text-xs text-fg-muted">{formatDuration(exec.durationMs)}</span>
                  )}
                  {exec.taskId && (
                    <button className="text-xs text-accent hover:underline flex items-center gap-1 mt-0.5">
                      <ExternalLink size={10} /> View task
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / Edit Trigger Form (Slide-over)
// ---------------------------------------------------------------------------

const TEMPLATE_VARIABLES = [
  { group: 'schedule', vars: ['time', 'timeLocal', 'dayOfWeek', 'dayOfMonth', 'hour', 'hourLocal', 'month', 'year', 'iso'] },
  { group: 'trigger', vars: ['name', 'id'] },
  { group: 'project', vars: ['name', 'repository'] },
  { group: 'execution', vars: ['id', 'sequenceNumber'] },
];

const AGENT_PROFILES = ['(none — configure manually)', 'reviewer', 'implementer', 'planner'];

const AGENT_TYPES: { value: AgentType; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'openai-codex', label: 'OpenAI Codex' },
  { value: 'google-gemini', label: 'Google Gemini CLI' },
  { value: 'mistral-vibe', label: 'Mistral Vibe' },
  { value: 'opencode', label: 'OpenCode (SST)' },
];

const VM_SIZES: { value: VMSize; label: string; spec: string }[] = [
  { value: 'small', label: 'Small', spec: '2 vCPU · 4 GB RAM' },
  { value: 'medium', label: 'Medium', spec: '4 vCPU · 8 GB RAM' },
  { value: 'large', label: 'Large', spec: '8 vCPU · 16 GB RAM' },
];

const PERMISSION_MODES: { value: PermissionMode; label: string; desc: string }[] = [
  { value: 'default', label: 'Default', desc: 'Prompts for dangerous operations' },
  { value: 'acceptEdits', label: 'Accept Edits', desc: 'Auto-accept file edits' },
  { value: 'plan', label: 'Plan Only', desc: 'No tool execution, planning mode' },
  { value: 'dontAsk', label: "Don't Ask", desc: "Deny if not pre-approved" },
  { value: 'bypassPermissions', label: 'Bypass All', desc: 'Skip all permission checks' },
];

const AGENT_TYPE_LABELS: Record<AgentType, string> = {
  'claude-code': 'Claude Code',
  'openai-codex': 'OpenAI Codex',
  'google-gemini': 'Gemini CLI',
  'mistral-vibe': 'Mistral Vibe',
  'opencode': 'OpenCode',
};

const VM_SIZE_LABELS: Record<VMSize, string> = {
  small: 'Small (2 vCPU / 4 GB)',
  medium: 'Medium (4 vCPU / 8 GB)',
  large: 'Large (8 vCPU / 16 GB)',
};

const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan Only',
  dontAsk: "Don't Ask",
  bypassPermissions: 'Bypass All',
};

const TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Australia/Sydney',
  'UTC',
];

function CreateTriggerSlideOver({
  open,
  onClose,
  editTrigger,
}: {
  open: boolean;
  onClose: () => void;
  editTrigger?: Trigger | null;
}) {
  const isEdit = Boolean(editTrigger);
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<SchedulePreset>('daily');
  const [hour, setHour] = useState('09');
  const [minute, setMinute] = useState('00');
  const [weekday, setWeekday] = useState('1-5');
  const [cronExpr, setCronExpr] = useState('0 9 * * 1-5');
  const [onceDate, setOnceDate] = useState('');
  const [onceTime, setOnceTime] = useState('09:00');
  const [timezone, setTimezone] = useState('America/New_York');
  const [prompt, setPrompt] = useState('');
  const [profile, setProfile] = useState('');
  const [agentType, setAgentType] = useState<AgentType>('claude-code');
  const [model, setModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('acceptEdits');
  const [vmSize, setVmSize] = useState<VMSize>('medium');
  const [skipIfRunning, setSkipIfRunning] = useState(true);
  const useProfile = profile !== '';
  const [showPreview, setShowPreview] = useState(false);

  // Populate form when editing an existing trigger
  // biome-ignore lint: intentional dependency on editTrigger identity
  useEffect(() => {
    if (!editTrigger) return;
    setName(editTrigger.name);
    setPrompt(editTrigger.promptTemplate);
    setAgentType(editTrigger.agentConfig.agentType);
    setModel(editTrigger.agentConfig.model ?? '');
    setPermissionMode(editTrigger.agentConfig.permissionMode);
    setVmSize(editTrigger.agentConfig.vmSize);
    setProfile(editTrigger.agentProfile ?? '');
    setSkipIfRunning(editTrigger.skipIfRunning);
    setTimezone(editTrigger.cronTimezone ?? 'America/New_York');

    if (editTrigger.scheduleType === 'once') {
      setPreset('once');
      if (editTrigger.scheduledAt) {
        const d = new Date(editTrigger.scheduledAt);
        setOnceDate(d.toISOString().split('T')[0] ?? '');
        setOnceTime(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);
      }
    } else if (editTrigger.cronExpression) {
      const parts = editTrigger.cronExpression.split(' ');
      if (parts.length === 5) {
        const [min = '0', hr = '9', dom = '*', , dow = '*'] = parts;
        setMinute(min === '*' ? '00' : min);
        setHour(hr === '*' ? '09' : hr);
        setWeekday(dow === '*' ? '*' : dow);
        // Detect preset from cron
        if (min !== '*' && hr === '*') setPreset('hourly');
        else if (dom === '1' && dow === '*') setPreset('monthly');
        else if (dow !== '*' && dow !== '1-5') setPreset('weekly');
        else if (dow === '1-5' || (dom === '*' && dow === '*')) setPreset('daily');
        else { setPreset('advanced'); setCronExpr(editTrigger.cronExpression); }
      } else {
        setPreset('advanced');
        setCronExpr(editTrigger.cronExpression);
      }
    }
  }, [editTrigger]);

  const nextRuns = useMemo(() => getNextRuns(5), []);

  const isOneOff = preset === 'once';

  const computedCron = useMemo(() => {
    switch (preset) {
      case 'once': return null; // one-off, no cron
      case 'hourly': return '0 * * * *';
      case 'daily': return `${minute} ${hour} * * *`;
      case 'weekly': return `${minute} ${hour} * * ${weekday}`;
      case 'monthly': return `${minute} ${hour} 1 * *`;
      case 'advanced': return cronExpr;
      default: return '0 9 * * 1-5';
    }
  }, [preset, hour, minute, weekday, cronExpr]);

  const insertVariable = useCallback((varPath: string) => {
    setPrompt((prev) => prev + `{{${varPath}}}`);
  }, []);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-full max-w-[min(560px,95vw)] bg-canvas border-l border-border-default shadow-2xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 bg-canvas border-b border-border-default px-6 py-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-fg-primary flex items-center gap-2">
            {isEdit ? <Pencil size={18} className="text-accent" /> : <Sparkles size={18} className="text-accent" />}
            {isEdit ? 'Edit Trigger' : 'New Scheduled Trigger'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-md hover:bg-surface-hover transition-colors text-fg-muted">
            <X size={18} />
          </button>
        </div>

        <div className="p-6 grid gap-6">
          {/* Name */}
          <div className="grid gap-1.5">
            <label className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Daily PR Review"
              className="w-full py-2 px-3 rounded-md border border-border-default bg-inset text-fg-primary text-sm placeholder:text-fg-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/40"
            />
          </div>

          {/* Schedule */}
          <div className="grid gap-3">
            <label className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Schedule</label>

            {/* Preset tabs */}
            <div className="flex rounded-lg border border-border-default overflow-hidden">
              {(['once', 'hourly', 'daily', 'weekly', 'monthly', 'advanced'] as SchedulePreset[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPreset(p)}
                  className={`flex-1 py-2 text-xs font-medium capitalize transition-colors ${
                    preset === p
                      ? 'bg-accent text-fg-on-accent'
                      : 'bg-surface text-fg-muted hover:text-fg-primary hover:bg-surface-hover'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>

            {/* One-off date/time picker */}
            {isOneOff && (
              <div className="grid gap-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="grid gap-1 flex-1 min-w-[140px]">
                    <span className="text-xs text-fg-muted">Date</span>
                    <input
                      type="date"
                      value={onceDate}
                      onChange={(e) => setOnceDate(e.target.value)}
                      min={new Date().toISOString().split('T')[0]}
                      className="w-full py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:dark]"
                    />
                  </div>
                  <div className="grid gap-1">
                    <span className="text-xs text-fg-muted">Time</span>
                    <input
                      type="time"
                      value={onceTime}
                      onChange={(e) => setOnceTime(e.target.value)}
                      className="py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm focus:outline-none focus:ring-2 focus:ring-accent/40 [color-scheme:dark]"
                    />
                  </div>
                </div>
                {onceDate && (
                  <div className="text-xs text-fg-muted bg-surface-hover/50 px-3 py-2 rounded-md flex items-center gap-2">
                    <Calendar size={12} />
                    <span>
                      Scheduled for{' '}
                      <span className="text-fg-primary font-medium">
                        {new Date(`${onceDate}T${onceTime}`).toLocaleString('en-US', {
                          weekday: 'long',
                          month: 'long',
                          day: 'numeric',
                          year: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}
                      </span>
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Recurring schedule inputs */}
            {!isOneOff && preset !== 'hourly' && preset !== 'advanced' && (
              <div className="flex items-center gap-3 flex-wrap">
                {preset === 'weekly' && (
                  <div className="grid gap-1">
                    <span className="text-xs text-fg-muted">Run on</span>
                    <select
                      value={weekday}
                      onChange={(e) => setWeekday(e.target.value)}
                      className="py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm"
                    >
                      <option value="1-5">Weekdays</option>
                      <option value="1">Monday</option>
                      <option value="2">Tuesday</option>
                      <option value="3">Wednesday</option>
                      <option value="4">Thursday</option>
                      <option value="5">Friday</option>
                      <option value="6">Saturday</option>
                      <option value="0">Sunday</option>
                      <option value="*">Every day</option>
                    </select>
                  </div>
                )}
                <div className="grid gap-1">
                  <span className="text-xs text-fg-muted">at</span>
                  <div className="flex items-center gap-1">
                    <select
                      value={hour}
                      onChange={(e) => setHour(e.target.value)}
                      className="py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm"
                    >
                      {Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')).map((h) => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                    <span className="text-fg-muted">:</span>
                    <select
                      value={minute}
                      onChange={(e) => setMinute(e.target.value)}
                      className="py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm"
                    >
                      {['00', '15', '30', '45'].map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            )}

            {!isOneOff && preset === 'advanced' && (
              <div className="grid gap-1">
                <span className="text-xs text-fg-muted">Cron expression (5-field)</span>
                <input
                  type="text"
                  value={cronExpr}
                  onChange={(e) => setCronExpr(e.target.value)}
                  placeholder="0 9 * * 1-5"
                  className="w-full py-2 px-3 rounded-md border border-border-default bg-inset text-fg-primary text-sm font-mono placeholder:text-fg-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/40"
                />
              </div>
            )}

            {/* Timezone */}
            <div className="grid gap-1">
              <span className="text-xs text-fg-muted">Timezone</span>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>{tz.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>

            {/* Computed cron (recurring only) */}
            {!isOneOff && (
              <div className="text-xs text-fg-muted font-mono bg-surface-hover/50 px-3 py-2 rounded-md flex items-center gap-2">
                <Code2 size={12} /> {computedCron}
              </div>
            )}

            {/* Next 5 runs (recurring only) */}
            {!isOneOff && (
              <div className="border border-border-default rounded-md bg-surface">
                <button
                  onClick={() => setShowPreview(!showPreview)}
                  className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium text-fg-muted hover:text-fg-primary transition-colors"
                >
                  <span className="flex items-center gap-1.5">
                    <Calendar size={12} /> Next 5 runs
                  </span>
                  {showPreview ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                {showPreview && (
                  <div className="px-3 pb-3 grid gap-1">
                    {nextRuns.map((run, i) => (
                      <p key={i} className="text-xs text-fg-primary">{run}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Prompt Template */}
          <div className="grid gap-2">
            <label className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Prompt Template</label>
            <div className="flex gap-3">
              {/* Editor */}
              <div className="flex-1">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Describe what the agent should do each time this trigger fires..."
                  rows={10}
                  className="w-full py-2.5 px-3 rounded-md border border-border-default bg-inset text-fg-primary text-sm font-mono placeholder:text-fg-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/40 resize-y leading-relaxed"
                />
              </div>

              {/* Variables sidebar */}
              <div className="w-40 shrink-0 border border-border-default rounded-md bg-surface overflow-hidden">
                <div className="px-2.5 py-2 border-b border-border-default">
                  <p className="text-xs font-semibold text-fg-muted">Variables</p>
                </div>
                <div className="p-2 grid gap-2 max-h-64 overflow-y-auto">
                  {TEMPLATE_VARIABLES.map((group) => (
                    <div key={group.group}>
                      <p className="text-xs font-medium text-accent mb-1">{group.group}</p>
                      {group.vars.map((v) => (
                        <button
                          key={v}
                          onClick={() => insertVariable(`${group.group}.${v}`)}
                          className="block w-full text-left text-xs text-fg-muted hover:text-fg-primary hover:bg-surface-hover px-1.5 py-0.5 rounded transition-colors font-mono"
                          title={`Insert {{${group.group}.${v}}}`}
                        >
                          .{v}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Preview */}
            {prompt && (
              <div className="border border-border-default rounded-md bg-surface-hover/30">
                <div className="px-3 py-2 border-b border-border-default flex items-center gap-1.5">
                  <Eye size={12} className="text-fg-muted" />
                  <span className="text-xs font-medium text-fg-muted">Preview (with sample data)</span>
                </div>
                <pre className="p-3 text-sm text-fg-primary font-mono whitespace-pre-wrap leading-relaxed">
                  {prompt
                    .replace(/\{\{schedule\.timeLocal\}\}/g, 'Apr 13, 2026 9:00 AM EDT')
                    .replace(/\{\{schedule\.time\}\}/g, '2026-04-13T13:00:00Z')
                    .replace(/\{\{schedule\.dayOfWeek\}\}/g, 'Monday')
                    .replace(/\{\{schedule\.iso\}\}/g, '2026-04-13')
                    .replace(/\{\{schedule\.month\}\}/g, 'April')
                    .replace(/\{\{schedule\.year\}\}/g, '2026')
                    .replace(/\{\{schedule\.hour\}\}/g, '13')
                    .replace(/\{\{schedule\.hourLocal\}\}/g, '9')
                    .replace(/\{\{schedule\.dayOfMonth\}\}/g, '13')
                    .replace(/\{\{trigger\.name\}\}/g, name || 'My Trigger')
                    .replace(/\{\{trigger\.id\}\}/g, 'trig_new01')
                    .replace(/\{\{project\.name\}\}/g, 'acme-api')
                    .replace(/\{\{project\.repository\}\}/g, 'acme/acme-api')
                    .replace(/\{\{execution\.id\}\}/g, 'exec_new01')
                    .replace(/\{\{execution\.sequenceNumber\}\}/g, '1')}
                </pre>
              </div>
            )}
          </div>

          {/* Agent Configuration */}
          <div className="border border-border-default rounded-lg bg-surface overflow-hidden">
            <div className="px-4 py-3 border-b border-border-default">
              <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Agent Configuration</h3>
            </div>
            <div className="p-4 grid gap-4">
              {/* Profile selector */}
              <div className="grid gap-1.5">
                <label className="text-xs text-fg-muted font-medium">Use a saved profile</label>
                <select
                  value={profile}
                  onChange={(e) => setProfile(e.target.value)}
                  className="w-full py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm"
                >
                  {AGENT_PROFILES.map((p) => (
                    <option key={p} value={p === '(none — configure manually)' ? '' : p}>
                      {p}
                    </option>
                  ))}
                </select>
                {useProfile && (
                  <p className="text-xs text-accent">
                    Using {profile} profile — settings below are overridden by the profile.
                  </p>
                )}
              </div>

              {/* Individual settings */}
              <div className={`grid gap-4 ${useProfile ? 'opacity-40 pointer-events-none' : ''}`}>
                {/* Agent type */}
                <div className="grid gap-1.5">
                  <label className="text-xs text-fg-muted font-medium">Coding Agent</label>
                  <select
                    value={agentType}
                    onChange={(e) => setAgentType(e.target.value as AgentType)}
                    className="w-full py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm"
                  >
                    {AGENT_TYPES.map((a) => (
                      <option key={a.value} value={a.value}>{a.label}</option>
                    ))}
                  </select>
                </div>

                {/* Model */}
                <div className="grid gap-1.5">
                  <label className="text-xs text-fg-muted font-medium">Model</label>
                  <input
                    type="text"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder={agentType === 'claude-code' ? 'e.g., claude-opus-4-6' : agentType === 'openai-codex' ? 'e.g., o3' : 'default'}
                    className="w-full py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm font-mono placeholder:text-fg-muted/50 focus:outline-none focus:ring-2 focus:ring-accent/40"
                  />
                  <p className="text-xs text-fg-muted">Leave empty to use the agent&apos;s default model</p>
                </div>

                {/* Permission mode + VM size side by side */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div className="grid gap-1.5">
                    <label className="text-xs text-fg-muted font-medium">Permission Mode</label>
                    <select
                      value={permissionMode}
                      onChange={(e) => setPermissionMode(e.target.value as PermissionMode)}
                      className="w-full py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm"
                    >
                      {PERMISSION_MODES.map((pm) => (
                        <option key={pm.value} value={pm.value}>{pm.label}</option>
                      ))}
                    </select>
                    <p className="text-xs text-fg-muted">
                      {PERMISSION_MODES.find((pm) => pm.value === permissionMode)?.desc}
                    </p>
                  </div>

                  <div className="grid gap-1.5">
                    <label className="text-xs text-fg-muted font-medium">VM Size</label>
                    <select
                      value={vmSize}
                      onChange={(e) => setVmSize(e.target.value as VMSize)}
                      className="w-full py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm"
                    >
                      {VM_SIZES.map((vs) => (
                        <option key={vs.value} value={vs.value}>{vs.label} — {vs.spec}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Advanced Settings */}
          <div className="border border-border-default rounded-lg bg-surface p-4 grid gap-3">
            <h3 className="text-xs font-semibold text-fg-muted uppercase tracking-wider">Execution Settings</h3>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={skipIfRunning}
                onChange={(e) => setSkipIfRunning(e.target.checked)}
                className="accent-accent w-4 h-4"
              />
              <span className="text-sm text-fg-primary">Skip if previous execution still running</span>
            </label>
            <div className="grid gap-1">
              <span className="text-xs text-fg-muted">Max concurrent executions</span>
              <select className="w-20 py-1.5 px-2 rounded-md border border-border-default bg-inset text-fg-primary text-sm">
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </select>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={() => { alert(isEdit ? `Would save changes to "${name}"` : `Would create trigger "${name}"`); onClose(); }}
              className="flex-1 py-2.5 rounded-md bg-accent text-fg-on-accent text-sm font-semibold hover:bg-accent/90 transition-colors"
            >
              {isEdit ? 'Save Changes' : 'Create Trigger'}
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2.5 rounded-md border border-border-default text-fg-muted text-sm font-medium hover:bg-surface-hover transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}


// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

type View = 'list' | 'detail' | 'chat-demo';

export function TriggersPrototype() {
  const [view, setView] = useState<View>('list');
  const [selectedTrigger, setSelectedTrigger] = useState<Trigger | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<Trigger | null>(null);
  const [triggers, setTriggers] = useState(MOCK_TRIGGERS);
  const [activeTab, setActiveTab] = useState<'triggers' | 'chat-inline'>('triggers');

  const handleToggleStatus = useCallback((id: string) => {
    setTriggers((prev) =>
      prev.map((t) =>
        t.id === id
          ? { ...t, status: t.status === 'active' ? 'paused' : 'active' as TriggerStatus }
          : t
      )
    );
  }, []);

  return (
    <div className="min-h-screen bg-canvas text-fg-primary p-4 sm:p-10 overflow-x-hidden">
    <div className="max-w-4xl mx-auto">
      {/* Page Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2 mb-1">
          <Zap size={20} className="text-accent" />
          <h1 className="text-xl font-bold text-fg-primary">Event-Driven Triggers</h1>
          <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-accent/10 text-accent">PROTOTYPE</span>
        </div>
        <p className="text-sm text-fg-muted">Automate recurring agent tasks with scheduled triggers, webhooks, and GitHub events.</p>
      </div>

      {/* Demo navigation tabs */}
      <div className="flex items-center gap-1 mb-6 border-b border-border-default">
        {([
          { key: 'triggers', label: 'Trigger Management', icon: <Clock size={14} /> },
          { key: 'chat-inline', label: 'Chat Creation', icon: <Sparkles size={14} /> },
        ] as const).map(({ key, label, icon }) => (
          <button
            key={key}
            onClick={() => { setActiveTab(key); setView('list'); setSelectedTrigger(null); }}
            className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
              activeTab === key
                ? 'border-accent text-accent'
                : 'border-transparent text-fg-muted hover:text-fg-primary'
            }`}
          >
            {icon} {label}
          </button>
        ))}
      </div>

      {/* Trigger Management View */}
      {activeTab === 'triggers' && (
        <>
          {view === 'list' && (
            <div className="grid gap-6">
              {/* List header */}
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div>
                  <h2 className="text-base font-semibold text-fg-primary">Triggers</h2>
                  <p className="text-xs text-fg-muted mt-0.5">Automate recurring and scheduled agent tasks.</p>
                </div>
                <button
                  onClick={() => setShowCreateForm(true)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold bg-accent text-fg-on-accent hover:bg-accent/90 transition-colors"
                >
                  <Plus size={14} /> New Trigger
                </button>
              </div>

              {/* Recurring triggers */}
              {triggers.filter((t) => t.scheduleType === 'recurring').length > 0 && (
                <div className="grid gap-3">
                  <div className="flex items-center gap-2">
                    <Clock size={14} className="text-fg-muted" />
                    <h3 className="text-sm font-semibold text-fg-muted uppercase tracking-wider">Recurring</h3>
                  </div>
                  {triggers.filter((t) => t.scheduleType === 'recurring').map((trigger) => (
                    <TriggerCard
                      key={trigger.id}
                      trigger={trigger}
                      onSelect={() => { setSelectedTrigger(trigger); setView('detail'); }}
                      onToggleStatus={() => handleToggleStatus(trigger.id)}
                      onRunNow={() => alert(`Would run "${trigger.name}" now`)}
                    />
                  ))}
                </div>
              )}

              {/* One-off scheduled triggers */}
              {triggers.filter((t) => t.scheduleType === 'once').length > 0 && (
                <div className="grid gap-3">
                  <div className="flex items-center gap-2">
                    <Calendar size={14} className="text-fg-muted" />
                    <h3 className="text-sm font-semibold text-fg-muted uppercase tracking-wider">Scheduled (one-off)</h3>
                  </div>
                  {triggers.filter((t) => t.scheduleType === 'once').map((trigger) => (
                    <TriggerCard
                      key={trigger.id}
                      trigger={trigger}
                      onSelect={() => { setSelectedTrigger(trigger); setView('detail'); }}
                      onToggleStatus={() => handleToggleStatus(trigger.id)}
                      onRunNow={() => alert(`Would run "${trigger.name}" now`)}
                    />
                  ))}
                </div>
              )}

            </div>
          )}

          {view === 'detail' && selectedTrigger && (
            <TriggerDetailView
              trigger={selectedTrigger}
              onBack={() => { setView('list'); setSelectedTrigger(null); }}
              onEdit={() => { setEditingTrigger(selectedTrigger); setShowCreateForm(true); }}
            />
          )}
        </>
      )}

      {/* Chat-Based Creation Demo */}
      {activeTab === 'chat-inline' && (
        <div className="grid gap-4">
          <div className="border border-border-default rounded-lg bg-surface p-4">
            <h3 className="text-sm font-semibold text-fg-primary mb-3">Chat-based trigger creation (MVP)</h3>
            <p className="text-xs text-fg-muted mb-4">
              The agent confirms trigger details in plain text. The user approves in natural language, and the agent calls the <code className="text-accent">create_trigger</code> MCP tool. No custom UI cards needed.
            </p>
          </div>

          {/* Simulated chat messages */}
          <div className="border border-border-default rounded-lg bg-canvas p-4 grid gap-4">
            {/* Agent message */}
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <Sparkles size={14} className="text-accent" />
              </div>
              <div className="bg-surface border border-border-default rounded-lg p-3 max-w-md">
                <p className="text-sm text-fg-primary leading-relaxed">
                  I&apos;ve reviewed all 3 open PRs. Here&apos;s the summary:
                </p>
                <ul className="text-sm text-fg-primary mt-2 grid gap-1">
                  <li>PR #142: Approved</li>
                  <li>PR #145: 2 issues found (test coverage)</li>
                  <li>PR #148: Needs architecture discussion</li>
                </ul>
              </div>
            </div>

            {/* User message */}
            <div className="flex gap-3 justify-end">
              <div className="bg-accent/10 border border-accent/20 rounded-lg p-3 max-w-md">
                <p className="text-sm text-fg-primary">
                  Great. Schedule this as a daily task at 9am ET every weekday.
                </p>
              </div>
              <div className="w-7 h-7 rounded-full bg-surface-hover flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-fg-muted">R</span>
              </div>
            </div>

            {/* Agent confirmation — plain text */}
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <Sparkles size={14} className="text-accent" />
              </div>
              <div className="bg-surface border border-border-default rounded-lg p-3 max-w-md">
                <p className="text-sm text-fg-primary leading-relaxed">
                  I&apos;ll set up a recurring trigger with these settings:
                </p>
                <ul className="text-sm text-fg-primary mt-2 grid gap-1.5 list-none">
                  <li><span className="text-fg-muted">Name:</span> Daily PR Review</li>
                  <li><span className="text-fg-muted">Schedule:</span> Weekdays at 9:00 AM ET</li>
                  <li><span className="text-fg-muted">Cron:</span> <code className="text-xs bg-surface-hover px-1 py-0.5 rounded font-mono">0 9 * * 1-5</code></li>
                  <li><span className="text-fg-muted">Agent:</span> Claude Code (claude-sonnet-4-5-20250929)</li>
                  <li><span className="text-fg-muted">VM:</span> Medium (4 vCPU / 8 GB)</li>
                  <li><span className="text-fg-muted">Permissions:</span> Accept Edits</li>
                </ul>
                <p className="text-sm text-fg-primary mt-3">
                  The prompt will be: <em className="text-fg-muted">&quot;Review all open pull requests. Check code quality, test coverage, and potential issues. Leave review comments.&quot;</em>
                </p>
                <p className="text-sm text-fg-primary mt-2 font-medium">
                  Should I create this trigger?
                </p>
              </div>
            </div>

            {/* User approval */}
            <div className="flex gap-3 justify-end">
              <div className="bg-accent/10 border border-accent/20 rounded-lg p-3 max-w-md">
                <p className="text-sm text-fg-primary">Yes, create it.</p>
              </div>
              <div className="w-7 h-7 rounded-full bg-surface-hover flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-fg-muted">R</span>
              </div>
            </div>

            {/* Agent calls tool and confirms */}
            <div className="flex gap-3">
              <div className="w-7 h-7 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                <Sparkles size={14} className="text-accent" />
              </div>
              <div className="grid gap-2 max-w-md">
                {/* Tool call indicator */}
                <div className="bg-surface border border-border-default rounded-lg px-3 py-2 flex items-center gap-2 text-xs text-fg-muted">
                  <Check size={12} className="text-green-400" />
                  <span className="font-mono">create_trigger</span>
                  <span className="text-fg-muted/50">—</span>
                  <span>completed</span>
                </div>
                <div className="bg-surface border border-border-default rounded-lg p-3">
                  <p className="text-sm text-fg-primary leading-relaxed">
                    Done! I&apos;ve created the <strong>&quot;Daily PR Review&quot;</strong> trigger. It will run every weekday at 9:00 AM ET starting tomorrow. You can manage it from the <span className="text-accent">Triggers</span> page in your project settings.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create form slide-over */}
      <CreateTriggerSlideOver
        open={showCreateForm}
        onClose={() => { setShowCreateForm(false); setEditingTrigger(null); }}
        editTrigger={editingTrigger}
      />
    </div>
    </div>
  );
}
