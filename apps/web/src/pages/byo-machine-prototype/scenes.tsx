/** PROTOTYPE: the terminal view of the CLI, and where "ran on your machine" shows up in the app. */
import { Chip, Pane } from '@simple-agent-manager/ui';
import { HardDrive } from 'lucide-react';
import { useState } from 'react';

import { TERMINALS, type TerminalVariant, type TermLine } from './mock-data';

const LINE_CLASS: Record<TermLine['t'], string> = {
  c: 'text-fg-primary font-semibold',
  ok: 'text-[var(--sam-status-success-fg)]',
  warn: 'text-[var(--sam-status-warning-fg)]',
  bad: 'text-[var(--sam-status-danger-fg)]',
  dim: 'text-fg-muted',
  p: 'text-fg-primary',
};

export function TerminalScene({ variant }: { variant: TerminalVariant }) {
  const terminal = TERMINALS[variant];
  return (
    <Pane className="flex min-w-0 flex-col gap-3 p-4">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="m-0 text-[15px] font-semibold text-fg-primary">{terminal.title}</h2>
        <p className="m-0 text-[13px] text-fg-muted">{terminal.caption}</p>
      </div>
      <div className="sam-well min-w-0 overflow-hidden rounded-[12px]">
        <div className="flex items-center gap-1.5 border-b border-[var(--sam-hairline)] px-3 py-2">
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--sam-hairline)]" />
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--sam-hairline)]" />
          <span aria-hidden="true" className="h-2.5 w-2.5 rounded-full bg-[var(--sam-hairline)]" />
          <span className="ml-2 font-mono text-[10.5px] text-fg-muted">raph@studio: ~</span>
        </div>
        <pre
          data-testid="terminal"
          className="m-0 whitespace-pre-wrap break-words p-3 font-mono text-[11.5px] leading-[1.65] md:text-[12.5px]"
        >
          {terminal.lines.map((line, index) => (
            <span key={index} className={`block min-h-[1.65em] ${LINE_CLASS[line.t]}`}>
              {line.t === 'c' ? <span className="text-fg-muted">$ </span> : null}
              {line.s}
            </span>
          ))}
        </pre>
      </div>
    </Pane>
  );
}

type Policy = 'pool' | 'wait';

const PLACEMENT_EXAMPLES: Array<{
  where: string;
  why: string;
  cost: string;
  tone: 'success' | 'info' | 'warning';
}> = [
  { where: 'studio', why: 'Your machine was online and had room.', cost: '$0', tone: 'success' },
  {
    where: 'GCP e2-standard-4 · Iowa',
    why: 'studio was offline, so this used your compute pool.',
    cost: '$0.134/h',
    tone: 'info',
  },
  {
    where: 'Waiting for studio',
    why: 'studio is full (32 of 32 GB set aside). Queued 12 minutes; gives up after 24 hours.',
    cost: '$0',
    tone: 'warning',
  },
];

export function PlacementScene() {
  const [policy, setPolicy] = useState<Policy>('pool');
  return (
    <div className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]">
      <Pane className="flex min-w-0 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[15px] font-semibold text-fg-primary">
            In a session: where it ran, and why
          </h2>
          <p className="m-0 text-[13px] text-fg-muted">
            One line in session details. Three cases a person will actually see.
          </p>
        </div>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {PLACEMENT_EXAMPLES.map((example) => (
            <li
              key={example.where}
              className="sam-well flex min-w-0 items-start gap-3 rounded-[12px] p-3"
            >
              <HardDrive size={16} className="mt-0.5 shrink-0 text-fg-muted" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="m-0 text-[13.5px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
                  {example.where}
                </p>
                <p className="m-0 text-[12.5px] text-fg-muted">{example.why}</p>
              </div>
              <Chip tone={example.tone} size="sm">
                {example.cost}
              </Chip>
            </li>
          ))}
        </ul>
      </Pane>

      <Pane className="flex min-w-0 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[15px] font-semibold text-fg-primary">
            When my machines are unavailable
          </h2>
          <p className="m-0 text-[13px] text-fg-muted">
            One setting for your account. Offline, full or updating all count.
          </p>
        </div>
        <div
          role="radiogroup"
          aria-label="When my machines are unavailable"
          className="flex flex-col gap-2"
        >
          {(
            [
              {
                id: 'pool',
                title: 'Use my compute pool',
                body: 'Work always starts. It may cost cloud money while your machine is off. The session says when this happened.',
              },
              {
                id: 'wait',
                title: 'Wait for my machine',
                body: 'Nothing is spent. Work queues with the reason shown and starts when a machine has room, for up to 24 hours.',
              },
            ] as const
          ).map((option) => {
            const checked = policy === option.id;
            return (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={checked}
                onClick={() => setPolicy(option.id)}
                className={`flex min-w-0 items-start gap-3 rounded-[12px] border p-3 text-left ${
                  checked ? 'sam-raised border-transparent' : 'border-border-default bg-transparent'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${
                    checked ? 'border-accent' : 'border-border-default'
                  }`}
                >
                  {checked && <span className="h-2 w-2 rounded-full bg-accent" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-semibold text-fg-primary">
                    {option.title}
                  </span>
                  <span className="block text-[12.5px] text-fg-muted">{option.body}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Pane>

      <Pane className="flex min-w-0 flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="m-0 text-[15px] font-semibold text-fg-primary">
            On the compute pools page
          </h2>
          <p className="m-0 text-[13px] text-fg-muted">
            A read-only first row shows the order. Machines are not pool entries.
          </p>
        </div>
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          <li className="sam-raised flex min-w-0 items-center gap-3 rounded-[12px] p-3">
            <span className="font-mono text-[11px] text-fg-muted">1</span>
            <span className="min-w-0 flex-1 text-[13.5px] text-fg-primary">
              Your machines <span className="text-fg-muted">· 2 online · used first</span>
            </span>
            <Chip tone="success" size="sm">
              $0
            </Chip>
          </li>
          {['GCP · e2-standard-4 · Iowa', 'Hetzner · cx43 · Falkenstein'].map((row, index) => (
            <li key={row} className="sam-well flex min-w-0 items-center gap-3 rounded-[12px] p-3">
              <span className="font-mono text-[11px] text-fg-muted">{index + 2}</span>
              <span className="min-w-0 flex-1 text-[13.5px] text-fg-primary [overflow-wrap:anywhere]">
                {row}
              </span>
            </li>
          ))}
        </ol>
      </Pane>
    </div>
  );
}
