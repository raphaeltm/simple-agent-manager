/** SQL definition of an idea. T8 widens this when is_idea is added to tasks. */
export function ideaTaskPredicateSql(alias = 'tasks'): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) throw new Error('Invalid SQL table alias');
  return `${alias}.status = 'draft'`;
}
