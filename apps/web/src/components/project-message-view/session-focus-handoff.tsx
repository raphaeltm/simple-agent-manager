import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

/**
 * Keeps keyboard focus in the chat across a switch between chats.
 *
 * Every chat is its own keyed subtree, so a control inside one that opens another
 * chat — the parent-session link, a Fork or Retry that lands on the new chat — is
 * removed by the very switch it causes, and focus would drop to the page body.
 * When focus was inside the outgoing chat, the incoming one moves it to its title
 * once that renders.
 */
interface FocusHandoff {
  /** Holds every chat this view renders, across switches. */
  container: RefObject<HTMLDivElement | null>;
  /** The outgoing chat held focus, and the incoming one has not taken it yet. */
  pending: { current: boolean };
}

const FocusHandoffContext = createContext<FocusHandoff | null>(null);

export function SessionFocusHandoff({ children }: Readonly<{ children: ReactNode }>) {
  const container = useRef<HTMLDivElement>(null);
  const pending = useRef(false);
  const [handoff] = useState<FocusHandoff>(() => ({ container, pending }));
  return (
    <FocusHandoffContext.Provider value={handoff}>
      {/* `contents`: no box of its own, so the chat lays out exactly as without it. */}
      <div ref={container} className="contents">
        {children}
      </div>
    </FocusHandoffContext.Provider>
  );
}

/**
 * Called by each chat. `titleShown` turns true once the chat's title
 * (`[data-session-title]`) is rendered.
 */
export function useSessionFocusHandoff(titleShown: boolean): void {
  const handoff = useContext(FocusHandoffContext);

  // Leaving: a layout cleanup runs before React removes this chat's DOM, so
  // whether focus was inside it can still be read.
  useLayoutEffect(
    () => () => {
      const active = document.activeElement;
      if (handoff && active && handoff.container.current?.contains(active)) {
        handoff.pending.current = true;
      }
    },
    [handoff]
  );

  // Arriving: take focus only if nothing else has since.
  useLayoutEffect(() => {
    if (!titleShown || !handoff?.pending.current) return;
    handoff.pending.current = false;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    handoff.container.current
      ?.querySelector<HTMLElement>('[data-session-title]')
      ?.focus({ preventScroll: true });
  }, [handoff, titleShown]);
}
