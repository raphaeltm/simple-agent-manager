import { Maximize2, Minimize2 } from 'lucide-react';
import { useEffect } from 'react';

import { useIsMobile } from '../../hooks/useIsMobile';
import { useChatImmersive } from '../shell/chat-immersive-context';
import {
  enterChatImmersive,
  exitChatImmersive,
  resetChatImmersive,
} from '../shell/chat-immersive-transition';

/**
 * Phone-only button at the bottom right of the conversation that slides the rest of the app
 * away so only the conversation shows, and brings it back. Desktop has Focus and Zen modes for
 * the same job, so the button renders nothing there.
 */
export function ImmersiveChatToggle({ agentActive }: Readonly<{ agentActive: boolean }>) {
  const isMobile = useIsMobile();
  const { active, setActive } = useChatImmersive();
  // Leaving the chat, or the phone layout, must never strand the shell with its chrome pinned
  // or slid away.
  // `setActive` is the shell's state setter, so these run on mount/unmount and breakpoint changes.
  useEffect(() => () => resetChatImmersive(setActive), [setActive]);
  useEffect(() => {
    if (!isMobile) resetChatImmersive(setActive);
  }, [isMobile, setActive]);

  if (!isMobile) return null;
  const label = active ? 'Show the rest of the app' : 'Show only the conversation';
  return (
    <button
      type="button"
      onClick={() => {
        void (active ? exitChatImmersive(setActive) : enterChatImmersive(setActive));
      }}
      aria-label={label}
      aria-pressed={active}
      title={label}
      data-testid="chat-immersive-toggle"
      data-agent-active={agentActive}
      className="sam-immersive-toggle sam-raised absolute right-4 z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border-0 text-fg-primary shadow-[var(--sam-glass-v2-depth-slab)] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
    >
      {active ? (
        <Minimize2 size={18} aria-hidden="true" />
      ) : (
        <Maximize2 size={18} aria-hidden="true" />
      )}
    </button>
  );
}
