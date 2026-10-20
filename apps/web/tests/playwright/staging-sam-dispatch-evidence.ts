export const READS = new Set([
  'sam_projects_list',
  'sam_inbox_get',
  'sam_project_get',
  'sam_chats_list',
  'sam_task_get',
  'sam_tasks_list',
  'sam_chat_read',
  'sam_chats_search',
  'sam_ideas_search',
  'sam_idea_get',
  'sam_profiles_list',
  'sam_private_history_search',
]);
export type Json = Record<string, any>;
interface Action {
  id: string;
  operation: string;
  state: string;
  input_json: string;
  result_json: string | null;
}
export interface Turn {
  id: string;
  request_key: string;
  state: string;
  response: string | null;
  actions: Action[];
}
export type DispatchPhase =
  | 'setup'
  | 'dispatch'
  | 'initial-answer'
  | 'runtime-evidence'
  | 'followup'
  | 'followup-answer'
  | 'stop'
  | 'stop-confirm';

/** Only fixed diagnostic categories may enter artifacts, never caught errors or bodies. */
export function safeDispatchFailure(phase: DispatchPhase, lastPrivateTurnState: unknown) {
  const states = ['accepted', 'running', 'completed', 'failed', 'cancelled', 'interrupted'];
  return {
    phase,
    lastPrivateTurnState:
      typeof lastPrivateTurnState === 'string' && states.includes(lastPrivateTurnState)
        ? lastPrivateTurnState
        : 'not-observed',
  };
}
