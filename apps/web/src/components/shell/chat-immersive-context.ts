import { createContext, useContext } from 'react';

/**
 * The phone-only "just the conversation" view of project chat: the app bar, session header,
 * tool rail and composer slide away so the conversation fills the screen
 * (`chat-immersive-transition.ts` runs the slide).
 *
 * Its own context rather than a field on `AppShellContext`, so toggling it re-renders only the
 * few components that change shape (the shell frame, the tool rail gutter, the toggle), not
 * every consumer of the shell context, such as the whole chat page.
 */
export interface ChatImmersiveValue {
  /** Whether the immersive view is on. Always `false` outside the phone layout. */
  active: boolean;
  setActive: (on: boolean) => void;
}

export const ChatImmersiveContext = createContext<ChatImmersiveValue>({
  active: false,
  setActive: () => {},
});

export function useChatImmersive(): ChatImmersiveValue {
  return useContext(ChatImmersiveContext);
}
