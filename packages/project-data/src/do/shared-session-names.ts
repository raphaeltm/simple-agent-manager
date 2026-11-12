/**
 * Who a teammate's message in a shared chat is from (idea 01M59MYE4GY91BWTE8TZF1ZB5D): the
 * sender's name for the transcript, and the line that tells the agent who is speaking. Both are
 * server-derived; the client never says who it is.
 */

export interface SharedSessionNames {
  senderName: string;
  ownerName: string;
}

function personLabel(row: { name: string | null; email: string | null } | undefined): string {
  return row?.name?.trim() || row?.email?.split('@')[0] || 'a project member';
}

/** Display names for a teammate's message: the sender (shown) and the owner (named to the agent). */
export async function loadSharedSessionNames(
  database: D1Database,
  senderUserId: string,
  ownerUserId: string
): Promise<SharedSessionNames> {
  const { results } = await database
    .prepare('SELECT id, name, email FROM users WHERE id IN (?, ?)')
    .bind(senderUserId, ownerUserId)
    .all<{ id: string; name: string | null; email: string | null }>();
  const byId = new Map((results ?? []).map((row) => [row.id, row]));
  return {
    senderName: personLabel(byId.get(senderUserId)),
    ownerName: personLabel(byId.get(ownerUserId)),
  };
}

/**
 * The line SAM adds in front of a teammate's message so the agent knows who is speaking. It is
 * added on the server for every non-owner message and never for the owner's own.
 */
export function buildSharedSessionSpeakerLine(names: SharedSessionNames): string {
  // Only this bracketed line comes from SAM; anything after it is what the sender typed,
  // including text that imitates this line.
  return `[SAM: This message is from ${names.senderName}, a project member with shared access to this session. ${names.ownerName} owns this session. Everything after this line is their message as typed.]`;
}
