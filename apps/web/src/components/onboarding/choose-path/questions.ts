/**
 * Choose-Your-Path onboarding question definitions.
 *
 * Each question branches to the next based on the user's answer.
 * Tags accumulate and drive the generated setup path.
 */

export interface PathQuestion {
  id: string;
  question: string;
  description: string;
  options: PathOption[];
}

export interface PathOption {
  id: string;
  label: string;
  description: string;
  icon: string;
  /** Next question ID, or null to end the question phase */
  next: string | null;
  /** Tags that influence the generated path */
  tags: string[];
  /** Offered only when this installation can host repositories on Cloudflare Artifacts. */
  requiresArtifacts?: boolean;
}

/**
 * Constructs one answer option. Positional arguments keep each option on a
 * single call so the question table reads as data, not repeated object
 * literals.
 */
function opt(
  id: string,
  label: string,
  description: string,
  icon: string,
  next: string | null,
  tags: string[],
  requiresArtifacts = false
): PathOption {
  return { id, label, description, icon, next, tags, ...(requiresArtifacts ? { requiresArtifacts } : {}) };
}

export const QUESTIONS: PathQuestion[] = [
  {
    id: 'cloud-account',
    question: 'Do you have a cloud hosting account?',
    description:
      'AI agents need a real computer to run on. SAM creates temporary VMs for each task.',
    options: [
      opt(
        'byoc',
        'I have Hetzner or Scaleway',
        'Most cost-effective — you pay your cloud provider directly for usage',
        'H',
        'repo-source',
        ['byoc']
      ),
      opt(
        'no-cloud',
        'Use SAM-managed infrastructure',
        'Let SAM provision and manage VMs for you — bring your own cloud account anytime.',
        '\u{1F680}',
        'repo-source',
        []
      ),
    ],
  },
  {
    id: 'repo-source',
    question: 'Where should your code live?',
    description:
      'Agents work on a Git repository. SAM can host it for you, or connect to GitHub.',
    options: [
      opt(
        'sam-hosted',
        'Let SAM host it',
        'SAM keeps the repository in your Cloudflare account. No GitHub account needed.',
        '\u{1F4E6}',
        null,
        ['repo-artifacts'],
        true
      ),
      opt(
        'yes',
        'GitHub — I have a repo',
        'Connect GitHub and pick the repository to work on',
        '\u{1F4C2}',
        null,
        ['has-repo']
      ),
      opt(
        'no-repo',
        "GitHub — I'll pick one after connecting",
        'Connect GitHub first, then choose or fork a repo',
        '\u{1F517}',
        null,
        []
      ),
    ],
  },
];

/** The questions this installation can answer: SAM-hosted repos only where Artifacts is on. */
export function questionsFor(options: { artifactsEnabled: boolean }): PathQuestion[] {
  return QUESTIONS.map((question) => ({
    ...question,
    options: question.options.filter(
      (option) => !option.requiresArtifacts || options.artifactsEnabled
    ),
  }));
}
