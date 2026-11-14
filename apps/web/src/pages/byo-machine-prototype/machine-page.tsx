/** PROTOTYPE: one machine's page. Pause, Resume and Remove are the only node actions. */
import { Button, Chip, Pane, PaneSeparator, SegmentedControl } from '@simple-agent-manager/ui';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import { hardwareLine, SessionLine, STATE_CHIP } from './machine-card';
import type { MockMachine, PlacementMode } from './mock-data';

const MODE_OPTIONS: Array<{ value: PlacementMode; label: string }> = [
  { value: 'automatic', label: 'Use first' },
  { value: 'manual', label: 'If I pick it' },
  { value: 'paused', label: 'Paused' },
];

const MODE_HELP: Record<PlacementMode, string> = {
  automatic: 'New chats and tasks start here when it is online and has room.',
  manual: 'Used only when you choose this machine for a chat or task.',
  paused: 'Nothing new starts here. Running sessions keep going until they sleep.',
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 py-2">
      <dt className="shrink-0 text-[13px] text-fg-muted">{label}</dt>
      <dd className="m-0 min-w-0 text-right font-mono text-[12px] text-fg-primary [overflow-wrap:anywhere]">
        {value}
      </dd>
    </div>
  );
}

export function MachinePage({
  machine,
  onBack,
  onReconnect,
}: {
  machine: MockMachine;
  onBack: () => void;
  onReconnect: () => void;
}) {
  const [mode, setMode] = useState<PlacementMode>(machine.mode);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const chip =
    mode === 'paused' && machine.state === 'online' ? STATE_CHIP.paused : STATE_CHIP[machine.state];
  const connected = machine.state !== 'pending' && machine.state !== 'pending-expired';
  return (
    <div className="flex min-w-0 flex-col gap-[var(--sam-space-gutter)]">
      <Pane variant="slab" as="header" className="flex min-w-0 flex-col gap-3 p-4">
        <nav aria-label="Breadcrumb" className="flex items-center gap-1 text-[12px] text-fg-muted">
          <button
            type="button"
            onClick={onBack}
            className="border-0 bg-transparent p-0 text-fg-muted underline"
          >
            Nodes
          </button>
          <ChevronRight size={12} aria-hidden="true" />
          <span className="min-w-0 truncate">{machine.name}</span>
        </nav>
        <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-2">
          <h1 className="m-0 line-clamp-3 min-w-0 flex-1 basis-[200px] break-words text-[24px] font-bold leading-tight text-fg-primary [overflow-wrap:anywhere]">
            {machine.name}
          </h1>
          <Chip tone={chip.tone} dot={chip.dot}>
            {chip.label}
          </Chip>
        </div>
        <p className="m-0 text-[13px] text-fg-muted [overflow-wrap:anywhere]">
          Your machine · {hardwareLine(machine)} · last seen {machine.lastSeen}
        </p>
        {connected && machine.state !== 'reconnect' && (
          <div>
            {mode === 'paused' ? (
              <Button variant="primary" onClick={() => setMode('automatic')}>
                Resume
              </Button>
            ) : (
              <Button variant="raised" onClick={() => setMode('paused')}>
                Pause
              </Button>
            )}
          </div>
        )}
      </Pane>

      {machine.state === 'reconnect' && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[var(--sam-radius-pane)] bg-warning-tint p-4">
          <p className="m-0 min-w-0 flex-1 basis-[220px] text-[13.5px] text-warning-fg">
            This machine has been offline for {machine.lastSeen.replace(' ago', '')}, longer than
            its 30-day sign-in. Run one command on it to reconnect. Sessions and history are kept.
          </p>
          <Button variant="primary" onClick={onReconnect}>
            Get reconnect command
          </Button>
        </div>
      )}
      {machine.state === 'updating' && (
        <div className="rounded-[var(--sam-radius-pane)] bg-info-tint p-4 text-[13.5px] text-info-fg">
          Update pending: SAM agent 4a81d0e. It installs by itself once the{' '}
          {machine.sessions.length} running session
          {machine.sessions.length === 1 ? ' sleeps' : 's sleep'}. No new work starts here until
          then.
        </div>
      )}

      {connected && (
        <Pane className="flex min-w-0 flex-col gap-3 p-4">
          <h2 className="m-0 text-[15px] font-semibold text-fg-primary">
            When SAM uses this machine
          </h2>
          <SegmentedControl
            label="When SAM uses this machine"
            options={MODE_OPTIONS}
            value={mode}
            onChange={setMode}
            className="w-full sm:max-w-md"
          />
          <p className="m-0 text-[13px] text-fg-muted">{MODE_HELP[mode]}</p>
        </Pane>
      )}

      {connected && (
        <Pane className="flex min-w-0 flex-col p-4">
          <h2 className="m-0 text-[15px] font-semibold text-fg-primary">Running here</h2>
          {machine.sessions.length === 0 ? (
            <p className="m-0 mt-2 text-[13px] text-fg-muted">Nothing running.</p>
          ) : (
            <ul className="m-0 mt-1 list-none divide-y divide-[var(--sam-hairline)] p-0">
              {machine.sessions.map((session) => (
                <SessionLine key={session.id} session={session} />
              ))}
            </ul>
          )}
        </Pane>
      )}

      <Pane className="flex min-w-0 flex-col p-4">
        <details open={!connected}>
          <summary className="cursor-pointer text-[15px] font-semibold text-fg-primary">
            Details
          </summary>
          <dl className="m-0 mt-2 divide-y divide-[var(--sam-hairline)]">
            <Row label="Connection" value="Outbound tunnel · no inbound ports" />
            <Row label="Hardware" value={hardwareLine(machine)} />
            <Row label="SAM agent" value={machine.agentVersion ?? 'not installed'} />
            <Row label="Connector" value={machine.connectorVersion ?? 'not installed'} />
            <Row label="Added" value={machine.registered} />
            <Row label="Cost" value="$0 · not counted against node limits" />
            <Row label="ID" value={machine.id} />
          </dl>
        </details>
        <PaneSeparator className="my-3" />
        <details>
          <summary className="cursor-pointer text-[15px] font-semibold text-fg-primary">
            Limit resources
          </summary>
          <p className="mb-0 mt-2 text-[13px] text-fg-muted">
            {machine.limit
              ? `SAM may set aside up to ${machine.limit.vcpu} CPU and ${machine.limit.memoryGb} GB here.`
              : 'No limit: SAM may set aside the whole machine, minus a 1 GB reserve.'}{' '}
            SAM also stops placing work when the machine itself is short on memory or disk.
          </p>
        </details>
      </Pane>

      <Pane className="flex min-w-0 flex-col gap-3 p-4">
        <h2 className="m-0 text-[15px] font-semibold text-fg-primary">Remove machine</h2>
        <p className="m-0 text-[13px] text-fg-muted">
          Sleeps what is running, signs the machine out and deletes its connection. Works when the
          machine is offline or lost. Files on the machine stay until you run{' '}
          <code className="font-mono text-[12px] text-fg-primary">sudo sam runner uninstall</code>.
        </p>
        {confirmRemove ? (
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="danger" onClick={() => setConfirmRemove(false)}>
              Remove {machine.name.length > 24 ? 'this machine' : machine.name}
            </Button>
            <Button variant="ghost" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="ghost" onClick={() => setConfirmRemove(true)}>
              Remove machine…
            </Button>
          </div>
        )}
      </Pane>
    </div>
  );
}
