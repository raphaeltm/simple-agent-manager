/**
 * The single renderer for one policy line in the `get_instructions` policy block.
 *
 * The API's `formatPolicyDirectives` builds the block from these lines, and the web
 * Policies tab measures them to show how many characters a policy costs every agent
 * session. Both call this function, so the size an admin sees is the size agents
 * receive (rules 24 / 59).
 */

export interface PolicyDirectiveLineInput {
  id: string;
  title: string;
  content: string;
  scope?: string;
  expiresAt?: number | null;
}

/**
 * A policy's shelf life as a short inline annotation. Date-only keeps it to a few
 * tokens; it renders once per policy in every session.
 */
export function formatPolicyLifecycle(entry: Pick<PolicyDirectiveLineInput, 'scope' | 'expiresAt'>): string {
  if (entry.expiresAt === null || entry.expiresAt === undefined) return '';
  const date = new Date(entry.expiresAt).toISOString().slice(0, 10);
  return entry.scope === 'task' ? ` (task-scoped, expires ${date})` : ` (expires ${date})`;
}

/**
 * One policy, rendered in full. The id MUST be rendered in full: `policies_write`
 * update/remove resolve it with an exact `WHERE id = ?`. The lifecycle annotation sits
 * between the title and the id so a temporary policy reads as temporary at a glance.
 */
export function formatPolicyDirectiveLine(entry: PolicyDirectiveLineInput): string {
  return `- **${entry.title}**${formatPolicyLifecycle(entry)} (id: ${entry.id}): ${entry.content}`;
}

/**
 * One on-demand policy that is not shown in full: title and id only. The agent fetches
 * the body with `policies_read` method `get` before acting in its area.
 */
export function formatPolicyIndexLine(entry: PolicyDirectiveLineInput & { category: string }): string {
  return `- **${entry.title}**${formatPolicyLifecycle(entry)} (${entry.category}, id: ${entry.id})`;
}
