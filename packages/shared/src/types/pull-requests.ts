/** Canonical GitHub pull request reference attached to linked work. */
export interface PullRequestRef {
  url: string;
  number: number;
  source: 'task_output' | 'pr_association' | 'explicit_link';
}

/** Last observed state from a verified webhook or authorized GitHub read. */
export interface PullRequestState {
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  title: string | null;
  checksState: 'pending' | 'success' | 'failure' | 'neutral' | null;
  mergedAt: string | null;
  updatedAt: string | null;
  stale: boolean;
  /** Head commit the stored state and checks describe, when GitHub has reported it. */
  headSha?: string | null;
  /** When the check rollup for that head commit last changed. */
  checksUpdatedAt?: string | null;
}
