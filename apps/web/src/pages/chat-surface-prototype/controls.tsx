/**
 * PROTOTYPE ONLY — the controls the chat-surface prototype adds to the real chat: the
 * immersive toggle (bottom-right of the conversation, phones only) and a "Prototype" options
 * pill in the mobile app bar. Both render nothing unless the prototype is on. Remove before
 * merge to main.
 */
import { paneClassName } from '@simple-agent-manager/ui';
import { FlaskConical, Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import {
  type AgentMessageStyle,
  type ImmersiveComposer,
  setChatSurfacePrototype,
  useChatSurfacePrototype,
} from './prototype-state';

export function ImmersiveToggle({ agentActive }: { agentActive: boolean }) {
  const proto = useChatSurfacePrototype();
  const isMobile = useIsMobile();

  // Leaving the chat (or the phone layout) must never strand the shell with its chrome hidden.
  useEffect(() => () => setChatSurfacePrototype({ immersive: false }), []);
  useEffect(() => {
    if (!isMobile) setChatSurfacePrototype({ immersive: false });
  }, [isMobile]);

  if (!proto.enabled || !isMobile) return null;
  const label = proto.immersive ? 'Show the rest of the app' : 'Show only the conversation';
  return (
    <button
      type="button"
      onClick={() => setChatSurfacePrototype({ immersive: !proto.immersive })}
      aria-label={label}
      aria-pressed={proto.immersive}
      title={label}
      data-agent-active={agentActive}
      className="proto-immersive-toggle sam-raised absolute right-4 z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border-0 text-fg-primary shadow-[var(--sam-glass-v2-depth-slab)] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      {proto.immersive ? (
        <Minimize2 size={18} aria-hidden="true" />
      ) : (
        <Maximize2 size={18} aria-hidden="true" />
      )}
    </button>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="m-0 border-0 p-0">
      <legend className="mb-1.5 p-0 text-xs font-semibold text-fg-muted">{label}</legend>
      <div className="sam-well flex rounded-[14px] p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`min-h-11 flex-1 cursor-pointer rounded-[12px] border-0 px-3 text-sm font-medium ${
              value === option.value
                ? 'sam-raised text-fg-primary'
                : 'bg-transparent text-fg-muted hover:text-fg-primary'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function PrototypeOptionsPill() {
  const proto = useChatSurfacePrototype();
  const [open, setOpen] = useState(false);
  if (!proto.enabled) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Prototype options"
        className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-full border border-dashed border-[var(--sam-color-warning)] bg-transparent text-fg-primary"
      >
        <FlaskConical size={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Prototype options"
          className={`${paneClassName('overlay')} fixed top-[76px] right-2.5 left-2.5 z-50 flex flex-col gap-4 p-4`}
        >
          <Segmented<AgentMessageStyle>
            label="Agent messages"
            value={proto.agentStyle}
            options={[
              { value: 'open', label: 'Open (new)' },
              { value: 'bubble', label: 'Bubble (today)' },
            ]}
            onChange={(agentStyle) => setChatSurfacePrototype({ agentStyle })}
          />
          <Segmented<ImmersiveComposer>
            label="Message box in immersive view"
            value={proto.composer}
            options={[
              { value: 'hide', label: 'Hide it' },
              { value: 'keep', label: 'Keep it' },
            ]}
            onChange={(composer) => setChatSurfacePrototype({ composer })}
          />
          <p className="m-0 text-xs text-fg-muted">
            Tap the expand button at the bottom right of the chat to hide everything but the
            conversation. Tap it again to come back. Sending a message gets a canned reply.
          </p>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="sam-raised min-h-11 cursor-pointer rounded-[14px] border-0 text-sm font-semibold text-fg-primary"
          >
            Done
          </button>
        </div>
      )}
    </>
  );
}
