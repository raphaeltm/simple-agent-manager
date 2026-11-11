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
  'dashboard': {
    width: 1800,
    height: 1125,
    alt: "The SAM home screen: active tasks across the Payments, Merchant Portal and Ledger projects, some in progress, one sleeping, two queued",
  },
  'needs-you': {
    width: 900,
    height: 205,
    alt: "An idea that needs you: Careful Builder asked a question about retrying failed webhook deliveries, with an Answer button",
  },
  'ideas': {
    width: 1100,
    height: 1175,
    alt: "The Ideas page: three ideas that need a person first (an agent's question, a failed run, a merged pull request), then two in progress",
  },
  'ideas-phone': {
    width: 750,
    height: 1230,
    alt: "The Ideas page on a phone: an agent's question, a failed run and a merged pull request, each with its next step as a button",
  },
  'idea-review': {
    width: 700,
    height: 268,
    alt: "An idea in review: PR #482 is open and its checks passed, with a Review PR button",
  },
  'idea-page': {
    width: 1400,
    height: 705,
    alt: "The idea Retry failed webhook deliveries: In review, PR #482 is open and checks passed, with the chats and pull request working on it",
  },
  'idea-page-phone': {
    width: 750,
    height: 900,
    alt: "The idea Retry failed webhook deliveries on a phone: In review, PR #482 is open and checks passed, above the plan",
  },
  'comment-reader': {
    width: 1300,
    height: 609,
    alt: "A comment on an agent's reply: highlighted words in the chat, and beside them Ben Okafor's question, the agent's answer, and Reply, Send to agent and Resolve buttons",
  },
  'comment-phone': {
    width: 750,
    height: 1474,
    alt: "A comment on an agent's reply on a phone: the highlighted words in the chat and the thread below them",
  },
  'library-doc': {
    width: 700,
    height: 493,
    alt: "A comment thread on one line of a migration plan in the project library, with a reply and a Resolve button",
  },
  'profiles': {
    width: 880,
    height: 760,
    alt: "Choosing who takes a new task: Brainstormer, Careful Builder, Code Reviewer and more, each with its agent and model, and a ring showing how much of its account is left",
  },
  'profiles-phone': {
    width: 750,
    height: 900,
    alt: "Choosing who takes a new task on a phone: profile cards with their agent, model and how much of their account is left",
  },
  'account-pick': {
    width: 800,
    height: 541,
    alt: "Choosing which of your own Claude Code accounts a profile runs on, marked Only you see this",
  },
  'workflow': {
    width: 1300,
    height: 1097,
    alt: "A workflow for Retry failed webhook deliveries: build the retry schedule, then review the code and try it against a flaky endpoint at the same time, apply both reviews, and wait for CI on PR #482",
  },
  'workflow-phone': {
    width: 800,
    height: 767,
    alt: "The workflow's steps: build, two reviews at the same time, apply both reviews, wait for CI on PR #482",
  },
  'machine': {
    width: 1400,
    height: 787,
    alt: "One machine on the Nodes page: a Hetzner server's memory and CPU, and three tasks each in its own container with what it uses against what was set aside for it, one of them over its limit",
  },
  'deploy': {
    width: 1300,
    height: 843,
    alt: "A staging environment, live, with recent deploys shipped by Claude Code and Codex agents from the chat Retry failed webhook deliveries",
  },
  'deploy-policy': {
    width: 856,
    height: 948,
    alt: "Who can deploy to staging: agents can deploy here, only these two profiles, Claude Code Opus 5 and Codex 5.5 High",
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
