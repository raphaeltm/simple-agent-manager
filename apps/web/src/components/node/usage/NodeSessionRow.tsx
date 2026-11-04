import type { NodeWorkspaceResourceUsage, WorkspaceStatus } from '@simple-agent-manager/shared';
import { PersonAvatar, personSlotFor } from '@simple-agent-manager/ui';
import { Circle, CircleAlert, Loader2, Moon, Square } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { CPU_COLOR, DANGER_COLOR, MEMORY_COLOR, MirrorChart, Swatch } from './MirrorChart';
import {
  formatAge,
  formatGb,
  formatGbBare,
  formatVcpu,
  formatVcpuBare,
  type SessionNow,
} from './node-resource-model';

const STATUS: Record<WorkspaceStatus, { label: string; icon: ReactNode }> = {
  running: {
    label: 'Running',
    icon: <Circle size={10} fill="currentColor" className="text-[var(--sam-status-success-fg)]" />,
  },
  pending: {
    label: 'Starting',
    icon: <Loader2 size={15} className="animate-spin text-fg-muted motion-reduce:animate-none" />,
  },
  creating: {
    label: 'Starting',
    icon: <Loader2 size={15} className="animate-spin text-fg-muted motion-reduce:animate-none" />,
  },
  recovery: {
    label: 'Recovering',
    icon: (
      <Loader2
        size={15}
        className="animate-spin text-[var(--sam-color-warning)] motion-reduce:animate-none"
      />
    ),
  },
  sleeping: {
    label: 'Sleeping',
    icon: <Moon size={15} strokeWidth={1.75} className="text-fg-muted" />,
  },
  stopping: {
    label: 'Stopping',
    icon: <Loader2 size={15} className="animate-spin text-fg-muted motion-reduce:animate-none" />,
  },
  stopped: { label: 'Stopped', icon: <Square size={12} className="text-fg-muted" /> },
  evicted: {
    label: 'Moved off this machine',
    icon: <Square size={12} className="text-fg-muted" />,
  },
  deleted: { label: 'Deleted', icon: <Square size={12} className="text-fg-muted" /> },
  error: {
    label: 'Error',
    icon: <CircleAlert size={15} className="text-[var(--sam-status-danger-fg)]" />,
  },
};

function ownerLabel(usage: NodeWorkspaceResourceUsage): string {
  if (usage.isMine) return 'You';
  return usage.ownerName?.trim().split(/\s+/)[0] || 'Someone';
}

export interface NodeSessionRowProps {
  usage: NodeWorkspaceResourceUsage;
  now: SessionNow;
  liveMemory: number | undefined;
  windowStart: number;
  windowEnd: number;
  bucketMs: number;
  clock: number;
}

export function NodeSessionRow({
  usage,
  now,
  liveMemory,
  windowStart,
  windowEnd,
  bucketMs,
  clock,
}: NodeSessionRowProps) {
  const status = STATUS[usage.status] ?? STATUS.running;
  const chatHref =
    usage.projectId && usage.chatSessionId
      ? `/projects/${usage.projectId}/chat/${usage.chatSessionId}`
      : null;
  const hasHistory = usage.series.start.length > 0;
  const memoryValues = usage.series.memoryBytes.filter((v): v is number => v != null);
  const cpuValues = usage.series.cpuMillis.filter((v): v is number => v != null);
  const memoryMax = Math.max(now.reservedMemoryBytes ?? 0, liveMemory ?? 0, ...memoryValues) * 1.08;
  const cpuMax = Math.max(now.reservedCpuMillis ?? 0, ...cpuValues) * 1.08;
  const cpuAge = now.cpuAt != null ? formatAge(now.cpuAt, clock) : null;

  const title = (
    <span className="line-clamp-2 break-words text-[13.5px] font-medium text-fg-primary md:line-clamp-1">
      {usage.title}
    </span>
  );

  return (
    <li className="flex min-h-[56px] items-start gap-2.5 py-2.5 md:items-center">
      <span
        className="mt-0.5 inline-flex w-4 shrink-0 justify-center md:mt-0"
        role="img"
        aria-label={status.label}
        title={status.label}
      >
        {status.icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 md:flex-row md:items-center md:gap-3">
        <div className="min-w-0 flex-1">
          {chatHref ? (
            <Link
              to={chatHref}
              className="block no-underline hover:underline focus-visible:outline-2 focus-visible:outline-focus-ring"
            >
              {title}
            </Link>
          ) : (
            title
          )}
          <div className="flex min-w-0 items-center gap-1.5 text-[12px] text-fg-muted">
            <PersonAvatar
              name={usage.ownerName ?? ownerLabel(usage)}
              person={usage.isMine ? 'you' : personSlotFor(usage.ownerUserId)}
              size={14}
              decorative
            />
            <span className="shrink-0">{ownerLabel(usage)}</span>
            {usage.projectName && (
              <>
                <span aria-hidden="true">·</span>
                <span className="min-w-0 truncate">{usage.projectName}</span>
              </>
            )}
            <span aria-hidden="true">·</span>
            <span className="shrink-0 font-mono text-[11px]">
              {formatAge(Date.parse(usage.createdAt), clock)}
            </span>
          </div>
        </div>
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex min-w-0 flex-1 md:w-[150px] md:flex-none">
            {hasHistory || liveMemory !== undefined ? (
              <MirrorChart
                series={usage.series}
                windowStart={windowStart}
                windowEnd={windowEnd}
                bucketMs={bucketMs}
                memoryMax={memoryMax}
                cpuMax={cpuMax}
                memoryReserved={now.reservedMemoryBytes}
                cpuReserved={now.reservedCpuMillis}
                memoryDanger={now.memoryOver}
                liveMemory={liveMemory}
                className="h-10 w-full min-w-0"
              />
            ) : (
              <span className="text-[11.5px] text-fg-muted">No usage recorded yet</span>
            )}
          </span>
          <div
            className="w-[108px] shrink-0 font-mono text-[11px] leading-[1.35]"
            aria-label={[
              now.memoryBytes != null ? `Memory ${formatGb(now.memoryBytes)}` : 'Memory unknown',
              now.reservedMemoryBytes != null
                ? `of ${formatGb(now.reservedMemoryBytes)} set aside`
                : '',
              now.cpuMillis != null ? `, CPU ${formatVcpu(now.cpuMillis)}` : ', CPU unknown',
              now.reservedCpuMillis != null
                ? `of ${formatVcpu(now.reservedCpuMillis)} set aside`
                : '',
            ].join(' ')}
          >
            <div
              className="flex items-center justify-end gap-1.5"
              title={now.memoryIsLive ? 'Live' : 'Newest history minute'}
            >
              <span
                className={
                  now.memoryOver ? 'text-[var(--sam-status-danger-fg)]' : 'text-fg-primary'
                }
              >
                {now.memoryBytes != null ? formatGbBare(now.memoryBytes) : '–'}
                {now.reservedMemoryBytes != null && (
                  <span className={now.memoryOver ? '' : 'text-fg-muted'}>
                    /{formatGb(now.reservedMemoryBytes)}
                  </span>
                )}
              </span>
              <Swatch color={now.memoryOver ? DANGER_COLOR : MEMORY_COLOR} />
            </div>
            <div
              className="flex items-center justify-end gap-1.5"
              title={cpuAge ? `Newest history minute, ${cpuAge} ago` : undefined}
            >
              <span className="text-fg-primary">
                {now.cpuMillis != null ? formatVcpuBare(now.cpuMillis) : '–'}
                {now.reservedCpuMillis != null && (
                  <span className="text-fg-muted">/{formatVcpu(now.reservedCpuMillis)}</span>
                )}
              </span>
              <Swatch color={CPU_COLOR} />
            </div>
            {(now.memoryOver || now.cpuOver) && (
              <div
                className={`text-right ${now.memoryOver ? 'text-[var(--sam-status-danger-fg)]' : 'text-fg-muted'}`}
              >
                {now.memoryOver ? 'over limit' : 'burst, fine'}
              </div>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}
