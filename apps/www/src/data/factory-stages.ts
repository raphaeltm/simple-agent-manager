/**
 * The software-factory homepage's main story: one idea (Northwind's payments team wants failed
 * webhook deliveries retried) moving through six stages. Each claim is checked against the docs
 * guides named in `source`. Ring boxes are percentages of the main image.
 */
import type { FactoryShotName } from './factory-shots';

export interface FactoryStage {
  id: string;
  name: string;
  title: string;
  body: string;
  /** Who takes part at this stage, in a few words. */
  who: string;
  main: FactoryShotName;
  inset?: FactoryShotName;
  /** Highlight around one control on the main image: [left, top, width, height] in %. */
  ring?: [number, number, number, number];
  /** Short note that lands on the picture after the ring. */
  note?: string;
  source: string;
}

export const factoryStages: FactoryStage[] = [
  {
    id: 'idea',
    name: 'Idea',
    title: 'Every request in one list',
    body: 'Anyone files an idea in a sentence, and agents file the follow-ups they find. The list puts what needs a person first, and each idea keeps track of the chats and pull requests working on it. A GitHub issue, a schedule, a webhook or an email (preview) can also start an agent directly.',
    who: 'Product, developers, agents',
    main: 'ideas',
    ring: [0, 24.6, 67.8, 21.4],
    note: 'An agent asked a question. It waits here, at the top.',
    source: 'guides/ideas.md, guides/triggers.md, guides/email-triggers.md',
  },
  {
    id: 'shape',
    name: 'Shape',
    title: 'Plan it with the agent in the room',
    body: 'Specs, designs and research go in the project library, where every agent can read them. Teammates comment on the exact words in a plan or an agent’s reply, mention each other, and send a thread to the agent when it should act on it.',
    who: 'Design, product, reviewers',
    main: 'comment-reader',
    inset: 'library-doc',
    ring: [76.6, 38.8, 12.2, 5],
    note: 'Send to agent: the comment becomes the agent’s next message.',
    source: 'guides/collaboration.md (comments, send to agent), features/comments.json (library)',
  },
  {
    id: 'start',
    name: 'Start',
    title: 'Pick who does the work',
    body: 'Profiles name the agent, model and machine size for a kind of work. Skills carry your process, and project rules load into every session, so nobody explains the codebase twice. Each person runs on their own Claude or ChatGPT plan or key, and sees how much room it has left.',
    who: 'Whoever starts the task',
    main: 'profiles',
    inset: 'account-pick',
    ring: [34.4, 23.8, 30.6, 31],
    source: 'concepts.mdx (profiles, skills), guides/agents.md (accounts and limits)',
  },
  {
    id: 'build',
    name: 'Build',
    title: 'Agents split the work and check on each other',
    body: 'A lead agent starts helper agents for parts of a job and messages them while they run. When steps depend on each other, it plans a workflow: draft, two reviews at once, apply both, publish. SAM starts each step when the ones before it finish.',
    who: 'Agents, with you watching',
    main: 'workflow',
    ring: [12.8, 49.6, 39, 9.4],
    note: 'Two reviewers, running at the same time.',
    source: 'guides/workflows.md, guides/idea-execution.md (agents starting agents)',
  },
  {
    id: 'review',
    name: 'Test and review',
    title: 'Your gates, where they already live',
    body: 'Agents open pull requests through a GitHub App you install, with only the permissions you grant it. Required checks and branch protection stay in GitHub. A review comment or a label can start an agent to answer it, and a workflow can wait for CI before its next step.',
    who: 'Reviewers, CI, agents',
    main: 'idea-page',
    ring: [66.4, 7.6, 33.4, 20.6],
    note: 'The idea knows its pull request passed its checks.',
    source: 'guides/self-hosting.mdx (GitHub App permissions), guides/triggers.md (review filters), guides/workflows.md (event waits)',
  },
  {
    id: 'ship',
    name: 'Ship',
    title: 'A running version, and who may push it',
    body: 'Create environments for previews and staging, and choose which agent profiles may deploy to each. Every chat shows who started it, and shared work that runs on someone’s personal key gets flagged.',
    who: 'Owners and admins decide; agents deploy',
    main: 'deploy',
    inset: 'attrib',
    ring: [0.8, 79.6, 36.4, 19],
    source: 'guides/app-deployments.md, guides/collaboration.md (credential attribution)',
  },
];
