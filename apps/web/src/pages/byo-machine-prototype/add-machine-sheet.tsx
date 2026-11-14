/** PROTOTYPE: the three-step "Add a machine" sheet. Mock data only; nothing is sent anywhere. */
import { Button, Dialog, Input, Spinner } from '@simple-agent-manager/ui';
import { Check, CheckCircle2, Copy } from 'lucide-react';
import { useState } from 'react';

import { INSTALL_COMMAND, RECONNECT_COMMAND } from './mock-data';

export type AddStep = 'name' | 'command' | 'connected' | 'expired' | 'reconnect';

const STEPS: Array<{ id: AddStep; label: string }> = [
  { id: 'name', label: 'Name' },
  { id: 'command', label: 'Command' },
  { id: 'connected', label: 'Online' },
];

function StepDots({ step }: { step: AddStep }) {
  const current = step === 'expired' ? 1 : STEPS.findIndex((s) => s.id === step);
  return (
    <ol className="m-0 flex list-none items-center gap-2 p-0" aria-label="Progress">
      {STEPS.map((s, index) => {
        const done = index < current;
        const active = index === current;
        return (
          <li key={s.id} className="flex min-w-0 items-center gap-2">
            <span
              aria-current={active ? 'step' : undefined}
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full font-mono text-[11px] ${
                done || active ? 'bg-accent text-fg-on-accent' : 'sam-well text-fg-muted'
              }`}
            >
              {done ? <Check size={13} aria-hidden="true" /> : index + 1}
            </span>
            <span className={`text-[12px] ${active ? 'text-fg-primary' : 'text-fg-muted'}`}>
              {s.label}
            </span>
            {index < STEPS.length - 1 && (
              <span aria-hidden="true" className="h-px w-3 bg-[var(--sam-hairline)] sm:w-6" />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function CommandBlock({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(command).catch(() => undefined);
    setCopied(true);
  };
  return (
    <div className="flex flex-col gap-2.5">
      <pre
        data-testid="install-command"
        className="sam-well m-0 max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-[12px] p-3 font-mono text-[12px] leading-relaxed text-fg-primary"
      >
        {command}
      </pre>
      <Button variant="primary" onClick={copy} className="w-full">
        <span className="inline-flex items-center gap-2">
          {copied ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy command'}
        </span>
      </Button>
    </div>
  );
}

const DETAILS_CLASS =
  'rounded-[12px] border border-border-default px-3 py-2 text-[13px] text-fg-muted [&_summary]:cursor-pointer [&_summary]:text-fg-primary';

export function AddMachineSheet({
  step,
  onStep,
  onClose,
}: {
  step: AddStep;
  onStep: (step: AddStep) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('studio');
  const isReconnect = step === 'reconnect';
  return (
    <Dialog isOpen onClose={onClose} maxWidth="md" aria-label="Add a machine">
      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-col gap-3">
          <h2 className="m-0 text-[18px] font-bold text-fg-primary">
            {isReconnect ? `Reconnect ${name}` : 'Add a machine'}
          </h2>
          {!isReconnect && <StepDots step={step} />}
        </div>

        {step === 'name' && (
          <>
            <p className="m-0 text-[14px] text-fg-muted">
              Run your agents on a computer you already own. It needs Linux, Docker and an internet
              connection. Nothing has to be opened on your router.
            </p>
            <label className="flex flex-col gap-1.5 text-[13px] text-fg-muted">
              Name
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={64}
                className="text-[16px]"
              />
            </label>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="primary" onClick={() => onStep('command')} disabled={!name.trim()}>
                Continue
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </>
        )}

        {step === 'command' && (
          <>
            <p className="m-0 text-[14px] text-fg-muted">
              Open a terminal on <strong className="break-words text-fg-primary">{name}</strong> and
              paste this. It asks for your password and one confirmation.
            </p>
            <CommandBlock command={INSTALL_COMMAND} />
            <div
              role="status"
              className="flex items-center gap-2.5 rounded-[12px] bg-info-tint px-3 py-2.5 text-[13px] text-info-fg"
            >
              <Spinner size="sm" />
              <span className="min-w-0 flex-1">Waiting for your machine…</span>
              <span className="shrink-0 font-mono text-[11px]">valid 14:32</span>
            </div>
            <details className={DETAILS_CLASS}>
              <summary>Requirements</summary>
              <ul className="mb-1 mt-2 flex list-disc flex-col gap-1 pl-5">
                <li>Linux (64-bit Intel/AMD or ARM) with systemd. On a Mac, use a Linux VM.</li>
                <li>Docker Engine already installed and running. SAM does not install it.</li>
                <li>An account that can use sudo.</li>
                <li>Outbound internet. No inbound ports, static IP or DNS needed.</li>
              </ul>
            </details>
            <details className={DETAILS_CLASS}>
              <summary>Other ways to install</summary>
              <p className="mb-1 mt-2">
                Download the CLI yourself, then run{' '}
                <code className="break-all font-mono text-[12px] text-fg-primary">
                  sudo sam runner install --code samreg_5H2K…
                </code>
                . Check the machine first, without changing anything, with{' '}
                <code className="font-mono text-[12px] text-fg-primary">sam runner doctor</code>.
              </p>
            </details>
            <button
              type="button"
              onClick={() => onStep('connected')}
              className="self-start border-0 bg-transparent p-0 font-mono text-[11px] text-fg-muted underline"
            >
              prototype: pretend the machine connected
            </button>
          </>
        )}

        {step === 'expired' && (
          <>
            <div className="rounded-[12px] bg-warning-tint px-3 py-2.5 text-[13px] text-warning-fg">
              This command expired after 15 minutes without being used. Nothing was installed.
            </div>
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="primary" onClick={() => onStep('command')}>
                Get a new command
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Not now
              </Button>
            </div>
          </>
        )}

        {step === 'connected' && (
          <>
            <div className="flex flex-col items-center gap-2 py-3 text-center">
              <CheckCircle2
                size={44}
                className="text-[var(--sam-status-success-fg)]"
                aria-hidden="true"
              />
              <p className="m-0 break-words text-[17px] font-semibold text-fg-primary [overflow-wrap:anywhere]">
                {name} is online
              </p>
              <p className="m-0 font-mono text-[12px] text-fg-muted">
                8 CPU · 32 GB · 212 GB free · Linux arm64
              </p>
              <p className="m-0 max-w-[36ch] text-[13px] text-fg-muted">
                Your chats and tasks now start here first. When it is off or full, they use your
                compute pool.
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <Button variant="primary" onClick={onClose}>
                Start a chat on this machine
              </Button>
              <Button variant="ghost" onClick={onClose}>
                Done
              </Button>
            </div>
          </>
        )}

        {step === 'reconnect' && (
          <>
            <p className="m-0 text-[14px] text-fg-muted">
              Run this on the machine. It keeps its name, sessions and history. The old sign-in
              stops working.
            </p>
            <CommandBlock command={RECONNECT_COMMAND} />
            <div
              role="status"
              className="flex items-center gap-2.5 rounded-[12px] bg-info-tint px-3 py-2.5 text-[13px] text-info-fg"
            >
              <Spinner size="sm" />
              <span className="min-w-0 flex-1">Waiting for {name}…</span>
              <span className="shrink-0 font-mono text-[11px]">valid 14:58</span>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
