/** Parts of `update_idea` (`./idea-core.ts`): a progress note, and the plan-content append. */
import { OperationError } from './errors';
import type { IdeaUpdateInput, IdeaUpdateResult } from './idea-core';
import { addIdeaUpdate, validateIdeaUpdateNote } from './idea-update-core';
import { sanitizeUserInput } from './sanitize-user-input';
import type { OperationContext } from './types';

/** A note is posted on its own; returns null when the update carries no note. */
export async function prepareIdeaNoteUpdate(
  ctx: OperationContext,
  input: IdeaUpdateInput,
  ideaId: string
): Promise<(() => Promise<IdeaUpdateResult>) | null> {
  if (input.quote !== undefined && input.note === undefined)
    throw new OperationError('invalid_input', 'quote requires note');
  if (input.note === undefined) return null;
  const note = input.note;
  if (
    input.title !== undefined ||
    input.content !== undefined ||
    input.priority !== undefined ||
    input.status !== undefined
  )
    throw new OperationError(
      'invalid_input',
      'Post a note separately from editing the current plan'
    );
  await validateIdeaUpdateNote(ctx, note, input.quote);
  return async () => {
    const { update } = await addIdeaUpdate(ctx, {
      projectId: input.projectId,
      ideaId,
      body: note,
      quote: input.quote,
    });
    return { updated: true, ideaId, updatedFields: [], note: update };
  };
}

/** Adds the SQL that replaces or appends to the idea's plan content. */
export function appendIdeaContentUpdate(
  input: IdeaUpdateInput,
  maxLength: number,
  updates: string[],
  bindValues: unknown[]
): void {
  if (typeof input.content !== 'string') return;
  const content = sanitizeUserInput(input.content).slice(0, maxLength);
  if (input.append !== false) {
    updates.push(
      'description = CASE WHEN description IS NULL THEN ? ELSE substr(description || char(10) || char(10) || ?, 1, ?) END'
    );
    bindValues.push(content, content, maxLength);
  } else {
    updates.push('description = ?');
    bindValues.push(content);
  }
}
