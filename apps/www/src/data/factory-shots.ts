/**
 * Real SAM screens used by the software-factory homepage (src/components/factory/). Every image is
 * a capture of the current app (real components, mocked Northwind Labs data) in both themes, cut by
 * the crops listed in `apps/www/public/images/factory/README.md`. Sizes are the published pixels.
 */
export interface FactoryShot {
  width: number;
  height: number;
  /** What the screen shows, for screen readers. */
  alt: string;
}

export const factoryShots = {
  dashboard: {
    width: 1800,
    height: 1125,
    alt: 'The SAM home screen: active tasks across the Payments, Merchant Portal and Ledger projects, some in progress, one sleeping, two queued',
  },
  'needs-you': {
    width: 900,
    height: 205,
    alt: 'An idea that needs you: Careful Builder asked a question about retrying failed webhook deliveries, with an Answer button',
  },
  ideas: {
    width: 1500,
    height: 1084,
    alt: 'The Ideas page: three ideas that need a person first, then two in progress and two not started, beside a panel explaining how ideas move on their own',
  },
  'idea-review': {
    width: 700,
    height: 268,
    alt: 'An idea in review: PR #482 is open and its checks passed, with a Review PR button',
  },
  'idea-page': {
    width: 1500,
    height: 998,
    alt: "The idea Retry failed webhook deliveries: its plan, updates from people and agents, the chats and pull request working on it, and the status In review with checks passed",
  },
  'comment-reader': {
    width: 1600,
    height: 1183,
    alt: "A comment on an agent's reply: highlighted words in the chat, and beside them Ben Okafor's question, the agent's answer, and Reply, Send to agent and Resolve buttons",
  },
  'library-doc': {
    width: 1300,
    height: 806,
    alt: 'A ledger migration plan in the project library, with a comment thread on one line of it',
  },
  profiles: {
    width: 1000,
    height: 789,
    alt: 'Choosing who takes a new task: Brainstormer, Careful Builder, Code Reviewer and Frontend Builder profiles, each with its agent, model and how much of its account is left',
  },
  'account-pick': {
    width: 800,
    height: 541,
    alt: 'Choosing which of your own Claude Code accounts a profile runs on, marked Only you see this',
  },
  workflow: {
    width: 1600,
    height: 1168,
    alt: 'A workflow run: draft the release notes, then two reviews at the same time, then apply both reviews and publish, with the details of one finished step',
  },
  machine: {
    width: 1400,
    height: 787,
    alt: "One machine on the Nodes page: a Hetzner server's memory and CPU, and three tasks each in its own container with what it uses against what was set aside for it, one of them over its limit",
  },
  deploy: {
    width: 1600,
    height: 1192,
    alt: 'A staging environment, live, with recent deploys shipped by Claude Code and Codex agents, and who is allowed to deploy to it',
  },
  attrib: {
    width: 900,
    height: 413,
    alt: "Credential attribution: a shared nightly automation flagged because it runs on one member's personal Claude Code key",
  },
} satisfies Record<string, FactoryShot>;

export type FactoryShotName = keyof typeof factoryShots;

export const factoryShotFiles = (name: FactoryShotName) => ({
  dark: `/images/factory/${name}.webp`,
  light: `/images/factory/${name}-light.webp`,
});

/**
 * The control plane on a single VM is in progress. While false, the page labels that option
 * "soon"; flip it when the single-VM installer ships.
 */
export const SINGLE_VM_INSTALL_SHIPPED = false;
