/**
 * Constants shared between the task-runtime liveness classifier and its D1
 * loaders, in their own module so neither imports the other.
 */

/**
 * Bound on the recursive supersession walk. The query is only reached for a task
 * already about to receive a terminal verdict, and the cap stops a corrupt cycle
 * from making the sweep unbounded (`.claude/rules/47`).
 */
export const MAX_TASK_SUPERSESSION_CHAIN_DEPTH = 32;
