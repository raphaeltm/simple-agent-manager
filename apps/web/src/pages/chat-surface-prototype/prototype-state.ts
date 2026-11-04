/**
 * PROTOTYPE ONLY — state for the chat-surface prototype, shared by the real components it
 * touches (app bar, conversation pane, agent message). Mirrored onto `<html>` as data
 * attributes so `prototype-styles.ts` can slide the chrome away with plain CSS. Remove before
 * merge to main.
 */
import { useSyncExternalStore } from 'react';

export type AgentMessageStyle = 'open' | 'bubble';
export type ImmersiveComposer = 'hide' | 'keep';

export interface ChatSurfacePrototypeState {
  enabled: boolean;
  agentStyle: AgentMessageStyle;
  immersive: boolean;
  composer: ImmersiveComposer;
}

const FLAG = 'sam-proto-chat-surface';
const STORAGE_KEY = 'sam-proto-chat-surface-options';

function readInitial(): ChatSurfacePrototypeState {
  const enabled =
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    window.sessionStorage.getItem(FLAG) === '1';
  let saved: Partial<ChatSurfacePrototypeState> = {};
  try {
    saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}');
  } catch {
    saved = {};
  }
  return {
    enabled,
    agentStyle: saved.agentStyle === 'bubble' ? 'bubble' : 'open',
    immersive: false,
    composer: saved.composer === 'keep' ? 'keep' : 'hide',
  };
}

let state: ChatSurfacePrototypeState = readInitial();
const listeners = new Set<() => void>();

function applyToDocument() {
  const root = document.documentElement;
  if (!state.enabled) return;
  root.dataset.protoAgent = state.agentStyle;
  root.dataset.protoImmersive = state.immersive ? 'on' : 'off';
  root.dataset.protoComposer = state.composer;
}

if (state.enabled) applyToDocument();

export function setChatSurfacePrototype(patch: Partial<ChatSurfacePrototypeState>) {
  state = { ...state, ...patch };
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ agentStyle: state.agentStyle, composer: state.composer })
  );
  applyToDocument();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChatSurfacePrototype(): ChatSurfacePrototypeState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state
  );
}
