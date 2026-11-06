/**
 * MCP `initialize` instructions: a short map of the SAM tool catalogue. Harnesses that
 * defer tools behind their own tool search (Claude Code, Codex) show these instructions
 * up front, so the model knows which tool names to search for. Keep it under 2 KB and
 * keep it in step with `tool-groups.ts` (a test checks every group is named here).
 */
export const MCP_SERVER_INSTRUCTIONS = [
  'SAM project tools. Call get_instructions first: it returns your task, project context, policies and how to report progress.',
  'Domain tools come in pairs, <domain>_read and <domain>_write, and take a `method` argument listed in each tool description:',
  'ideas_read/ideas_write (ideas = draft tasks, notes, links), knowledge_read/knowledge_write (remembered facts and preferences),',
  'policies_read/policies_write (project rules), tasks_read (project tasks, active agents), sessions_read (chat history and search),',
  'workspace_read (your workspace, credentials, usage limits), library_read (project files; upload_to_library, replace_library_file and',
  'display_from_library are separate), comments_read/comments_write (comment threads), profiles_read/profiles_write and',
  'skills_read/skills_write (agent configuration), schedules_read/schedules_write (one-off wake-ups), deployments_read/deployments_write (app deploys).',
  'Task lifecycle: update_task_status, complete_task, request_human_input, associate_pull_request, update_session_topic.',
  'Delegation and messaging: dispatch_task, wait_for_subtasks, send_durable_message, send_message_to_subtask, stop_subtask,',
  'retry_subtask, project event subscriptions and channels. Recurring automation: list_triggers, create_trigger, update_trigger.',
  'Older documents may name a per-operation tool such as search_ideas or add_knowledge: each group description lists the tools it replaces.',
].join(' ');
