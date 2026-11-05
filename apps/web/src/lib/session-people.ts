import type { SessionAccessSummary } from '@simple-agent-manager/shared';
import { type AvatarStackPerson, type PersonSlot, personSlotFor } from '@simple-agent-manager/ui';

import type { ChatSessionListItem } from './api';

/**
 * Task sources that start work on their own. Their sessions are owned by the automation, not
 * by the person whose trigger fired them, so the list shows "Automation" in the automation
 * colour instead of a teammate.
 */
const AUTOMATION_TRIGGERS: ReadonlySet<string> = new Set([
  'cron',
  'webhook',
  'github',
  'email',
  'incident',
]);

export interface SessionOwner {
  slot: PersonSlot;
  /** "You", "Automation", or the person's name. */
  label: string;
  /** Name for the avatar's initials and accessible name. */
  name: string;
}

/** Who started a session, for the chat list's owner line and edge light. */
export function sessionOwner(session: ChatSessionListItem): SessionOwner | null {
  const trigger = session.task?.triggeredBy;
  if (trigger && AUTOMATION_TRIGGERS.has(trigger)) {
    return { slot: 'auto', label: 'Automation', name: 'Automation' };
  }
  if (session.isMine) return { slot: 'you', label: 'You', name: 'You' };
  if (!session.createdByUserId) return null;
  const creator = session.createdBy;
  const name = creator?.name?.trim() || creator?.email?.split('@')[0] || 'Member';
  return { slot: personSlotFor(session.createdByUserId), label: name, name };
}

/**
 * Everyone who can see a session — its owner, then each active grant — as avatar-stack
 * entries in their person colours. Empty when the session carries no access summary.
 */
export function sessionPeople(
  access: SessionAccessSummary | null | undefined,
  viewerId: string | null
): AvatarStackPerson[] {
  if (!access) return [];
  const people: AvatarStackPerson[] = [];
  const seen = new Set<string>();
  const add = (person: { id: string; name: string | null; avatarUrl?: string | null } | null) => {
    if (!person || seen.has(person.id)) return;
    seen.add(person.id);
    people.push({
      id: person.id,
      name: person.name,
      slot: personSlotFor(person.id, viewerId),
      imageUrl: person.avatarUrl ?? null,
    });
  };
  add(access.owner);
  for (const grant of access.grants) add(grant.grantee);
  return people;
}
