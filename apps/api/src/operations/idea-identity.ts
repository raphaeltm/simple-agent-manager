/**
 * What makes a `tasks` row an idea.
 *
 * `is_idea` (`db/migrations/0207_tasks_idea_flag.sql`) is the whole definition, and
 * deliberately so. "An idea is a task in `draft`" was the old definition and the migration
 * backfills it, but it cannot be the live one: `POST /api/projects/:projectId/tasks` creates
 * every ordinary task in `draft` too (`routes/tasks/crud.ts`), so a union with it would list
 * other people's undispatched work as ideas and let the idea transition table move it to
 * `completed` — skipping dependency blocking and terminal-resource cleanup.
 *
 * `is_idea` is also what lets a *finished* idea still be one: a done idea is `completed`,
 * which is otherwise an ordinary finished task.
 *
 * This is the only definition. Idea notes, Start work, agent context and the Ideas pages all
 * call it, so nobody writes a second one (rule 24).
 */
export function ideaTaskPredicateSql(alias = 'tasks'): string {
  if (!/^[A-Za-z_]\w*$/.test(alias)) throw new Error('Invalid SQL table alias');
  return `${alias}.is_idea = 1`;
}

/** The row-level form of {@link ideaTaskPredicateSql}, for a row already read. */
export function isIdeaRow(row: { is_idea?: number | null }): boolean {
  return row.is_idea === 1;
}
