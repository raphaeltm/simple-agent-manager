/**
 * Generates a personalized setup path based on the user's answers (tags).
 *
 * Each step maps to a real action the user will take, backed by real API calls
 * in the execution phase.
 */

export type StepId = 'ai-setup' | 'cloud-byoc' | 'cloud-sam' | 'github' | 'project';

export interface GeneratedStep {
  id: StepId;
  title: string;
  description: string;
  actionLabel: string;
  timeEstimate: string;
  details: string[];
  /** Steps marked optional are already handled and shown as "Done" */
  isOptional: boolean;
}

/**
 * Constructs one step's static copy. Positional arguments keep each entry on a
 * single call so the wizard's copy table reads as data, not eight repeated
 * object literals.
 */
function step(
  id: StepId,
  title: string,
  description: string,
  actionLabel: string,
  timeEstimate: string,
  details: string[]
): Omit<GeneratedStep, 'isOptional'> {
  return { id, title, description, actionLabel, timeEstimate, details };
}

/**
 * Static copy for every step the wizard can produce. `generatePath` selects
 * which entries to emit based on the user's tags, then stamps `isOptional`.
 * Keyed by an internal slug so the two `project` variants can coexist; the
 * public `id` is carried on each entry.
 */
const STEP_CONTENT: Record<string, Omit<GeneratedStep, 'isOptional'>> = {
  'ai-setup': step(
    'ai-setup',
    'Connect an AI agent',
    'Pick the coding agent you want to use, then connect it — with your own API key, your provider subscription, or SAM-managed AI.',
    'Connect Agent',
    '1 minute',
    [
      'Choose from Claude Code, Codex, Gemini, Mistral, OpenCode, or Amp',
      'Bring your own API key, OAuth subscription, or use SAM-managed AI',
      'Your credentials are encrypted and stored securely',
      'You can change agents or switch connection method anytime',
    ]
  ),
  'cloud-byoc': step(
    'cloud-byoc',
    'Connect your cloud account',
    'Choose Hetzner or Scaleway and paste your credentials. SAM creates and destroys VMs automatically for each task.',
    'Connect Cloud',
    '1 minute',
    [
      'Use your own Hetzner or Scaleway account',
      'SAM creates right-sized VMs for workspaces',
      'VMs are destroyed when tasks complete',
      'You choose the region and VM size',
    ]
  ),
  'cloud-sam': step(
    'cloud-sam',
    'Infrastructure handled by SAM',
    'No setup needed! SAM provides cloud infrastructure. You can bring your own account later for more control.',
    'Continue',
    'Instant',
    [
      'SAM manages VMs in European data centers',
      'Infrastructure cost included in per-task billing',
      'Switch to your own Hetzner account later for savings',
      'Data isolated per-user — no shared VMs',
    ]
  ),
  github: step(
    'github',
    'Install SAM GitHub App',
    'Give SAM access to your repos so agents can clone code and open PRs. You choose which repos.',
    'Install GitHub App',
    '30 seconds',
    [
      'You choose which repos SAM can access',
      'Agents create branches and open PRs on your behalf',
      'Agents never push directly to main',
      'Change repo access anytime from GitHub settings',
    ]
  ),
  'project-has-repo': step(
    'project',
    'Create your first project',
    'Select one of your GitHub repos to create your first SAM project.',
    'Choose Repository',
    '30 seconds',
    [
      'Pick a repo from your connected GitHub account',
      'SAM clones it when creating workspaces',
      'Default branch detected automatically',
      'Add more projects later',
    ]
  ),
  'project-no-repo': step(
    'project',
    'Create your first project',
    'Pick any repo from your GitHub account, or fork an open-source project to get started.',
    'Choose Repository',
    '30 seconds',
    [
      'Pick any repo you have access to',
      'Try forking github.com/raphaeltm/simple-agent-manager to experiment',
      'SAM clones it when creating workspaces',
      'You can add more projects later',
    ]
  ),
};

export function generatePath(tags: string[]): GeneratedStep[] {
  const steps: GeneratedStep[] = [];
  const add = (key: string, isOptional: boolean) => {
    steps.push({ ...STEP_CONTENT[key]!, isOptional });
  };

  // AI agent setup — always emitted; agent + connection method are chosen inline.
  add('ai-setup', tags.includes('existing-agent'));

  // Cloud infrastructure — own cloud account vs SAM-managed.
  const cloudDone = tags.includes('existing-cloud');
  if (tags.includes('byoc')) add('cloud-byoc', cloudDone);
  else add('cloud-sam', cloudDone);

  // GitHub access.
  add('github', tags.includes('existing-github'));

  // First project — copy varies depending on whether the user has a repo.
  add(tags.includes('has-repo') ? 'project-has-repo' : 'project-no-repo', false);

  return steps;
}

export function getTimeEstimate(steps: GeneratedStep[]): string {
  let totalSeconds = 0;
  for (const step of steps) {
    if (step.isOptional) continue;
    const match = step.timeEstimate.match(/(\d+)/);
    if (match?.[1]) {
      const num = parseInt(match[1], 10);
      if (step.timeEstimate.includes('minute')) totalSeconds += num * 60;
      else totalSeconds += num;
    }
  }
  const minutes = Math.ceil(totalSeconds / 60);
  if (minutes === 0) return '< 1 min';
  return `~${minutes} min${minutes !== 1 ? 's' : ''}`;
}
