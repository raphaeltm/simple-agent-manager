import type {
  CapacityExhaustionPolicy,
  CapacityPoolScope,
  CapacityPoolStrategy,
  DefaultCapacityPoolEffectiveState,
} from '@simple-agent-manager/shared';

export interface ChoiceCopy {
  label: string;
  description: string;
}

/**
 * Plain-language names for how a pool places agent workspaces. Each description states
 * the strategy's defining rule in `placement-strategy.ts` (host order) and
 * `placement-capacity-ranking.ts` (which machine type a new machine uses).
 */
export const WORKSPACE_STRATEGY_COPY: Record<CapacityPoolStrategy, ChoiceCopy> = {
  balanced: {
    label: 'Balanced',
    description: 'New agents go to the least busy machine.',
  },
  pack: {
    label: 'Pack',
    description:
      'Fill busy machines first so fewer machines run. New machines use the largest allowed type.',
  },
  spread: {
    label: 'Spread',
    description: 'Give each agent its own machine until the machine limit, then share.',
  },
  'smallest-fit': {
    label: 'Smallest fit',
    description: 'Use the smallest allowed machine that fits each agent.',
  },
};

export const DEPLOYMENT_STRATEGY_HELP =
  'How SAM picks a machine type when an app deployment needs a new machine.';

/**
 * What happens when the cloud provider cannot create a machine. Mirrors
 * `node-provisioning-exhaustion.ts` (TaskRunner capacity-exhaustion planning).
 */
export const EXHAUSTION_POLICY_COPY: Record<CapacityExhaustionPolicy, ChoiceCopy> = {
  queue: {
    label: 'Wait and retry',
    description: 'The task waits for capacity to come back, up to a time limit.',
  },
  'fallback-chain': {
    label: 'Try other allowed machines',
    description: 'SAM tries the next allowed machine type or region before giving up.',
  },
  fail: {
    label: 'Stop with an error',
    description: 'The task stops with a capacity error instead of waiting.',
  },
};

export const EXHAUSTION_POLICY_TITLE = 'If the provider is out of capacity';

/**
 * The pool's machine limit caps managed workspace machines for every strategy
 * (`node-provisioning-step.ts`): at the limit, new work reuses a machine with room or
 * waits. Spread also uses it as the point where it stops opening one machine per agent
 * (`capacity-pool-node-limit.ts`).
 */
export const MACHINE_LIMIT_HELP =
  'The most machines SAM runs from this pool at once. At the limit, new work waits for room on a running machine.';
export const SPREAD_MACHINE_LIMIT_NOTE =
  'With Spread, each agent gets its own machine until the limit is reached.';

interface ScopeCopy {
  title: string;
  description: string;
  /** Possessive used in "Uses <owner> Hetzner account". */
  accountOwner: string;
  /** Whether the machine limit counts per person rather than for one owner. */
  limitPerPerson: boolean;
}

export const POOL_SCOPE_COPY: Record<CapacityPoolScope, ScopeCopy> = {
  user: {
    title: 'Your compute pool',
    description:
      'The machines SAM can start for your agents. Projects without their own pool use this one.',
    accountOwner: 'your',
    limitPerPerson: false,
  },
  project: {
    title: 'Project compute pool',
    description:
      "The machines SAM can start for this project. Machines from a project pool only run this project's work.",
    accountOwner: "this project's",
    limitPerPerson: true,
  },
  installation: {
    title: 'Shared compute pool',
    description:
      'Machines this installation provides to anyone who does not have a pool of their own.',
    accountOwner: 'the platform',
    limitPerPerson: true,
  },
};

/** Why a configured pool cannot start machines right now. */
export const POOL_STATE_WARNINGS: Partial<Record<DefaultCapacityPoolEffectiveState, string>> = {
  'configured-empty': "No machines are allowed, so SAM can't start any from this pool.",
  'source-disabled': 'The cloud account behind this pool is turned off or was removed.',
  'catalog-unavailable': "SAM couldn't read the provider's machine list. Try Refresh.",
  'migration-pending': 'This pool is being updated. Try again in a minute.',
};

/**
 * Provider order (`sourceOrder`). Mirrors the ranking in `placement-capacity-ranking.ts` and the
 * next-source fallback in `node-provisioning-tier.ts`: reuse is unaffected, and only sources with
 * different ranks fall back to each other.
 */
export const PROVIDER_ORDER_COPY = {
  help: 'A running machine with room is always used first. The order decides which account a new machine comes from, and SAM moves to the next account when one cannot start it.',
  singleSource:
    'This pool uses one account. Connect another cloud account to choose which one SAM tries first.',
  equal: {
    label: 'Every account is equal',
    description: 'The placement strategy and price decide. Nothing falls back across accounts.',
  },
  ordered: {
    label: 'Try accounts in this order',
    description: 'SAM starts new machines on the first account and falls back down the list.',
  },
} as const;

export const POOL_EDIT_CONFLICT_MESSAGE =
  'This pool changed while you were editing it, so your changes were not saved. Review the current pool and edit again.';

/** Shown when nothing in the pool can run work. Matches guides/instant-sessions.md. */
export const EMPTY_POOL_COPY = {
  title: 'Your pool is empty, so only Instant sessions can run.',
  body: 'Instant runs in a container on Cloudflare: no Docker, no devcontainer, and a slim toolchain (git, gh, curl, jq, uv, Node and the agent CLIs). Builds and test suites that need more will fail. Add machines from the list to run work on VMs.',
} as const;

export const POOL_EDITOR_COPY = {
  accountsTitle: 'In your pool',
  accountsHelp:
    'Switch accounts on or off for this pool. Switching one off keeps its machines for later. Disconnected accounts disappear from here on their own.',
  offTitle: 'Connected, not in this pool',
  noMachinesOn: 'Add machines from this account in the list.',
  catalogTitle: 'Available machines',
  catalogHelp:
    'One row per machine type and region. Prices are in each provider’s own currency. Adding a region lets SAM use any of its zones.',
  nothingAddedOnItsOwn:
    'Nothing is added on its own: new accounts, machine types and regions stay out until you add them.',
} as const;
