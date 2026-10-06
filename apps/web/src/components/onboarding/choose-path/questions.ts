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
  tags: string[]
): PathOption {
  return { id, label, description, icon, next, tags };
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
        'github-ready',
        ['byoc']
      ),
      opt(
        'no-cloud',
        'Use SAM-managed infrastructure',
        'Let SAM provision and manage VMs for you — bring your own cloud account anytime.',
        '\u{1F680}',
        'github-ready',
        []
      ),
    ],
  },
  {
    id: 'github-ready',
    question: 'Do you have a GitHub repo ready?',
    description:
      "SAM agents work on real code. You'll connect GitHub so they can clone repos and open PRs.",
    options: [
      opt(
        'yes',
        'Yes, I have a repo',
        'I have a project I want to work on',
        '\u{1F4C2}',
        null,
        ['has-repo']
      ),
      opt(
        'no-repo',
        "Not yet, I'll pick one after connecting",
        'Connect GitHub first, then choose or fork a repo',
        '\u{1F517}',
        null,
        []
      ),
    ],
  },
];
