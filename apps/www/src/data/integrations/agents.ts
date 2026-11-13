/**
 * Coding agents. Source of truth: AGENT_CATALOG in packages/shared/src/agents.ts, models in
 * packages/shared/src/model-catalog.ts, sign-in modes in apps/web/src/components/AgentSettingsCard.tsx
 * (supportsSamProvider, supportsOAuthProvider) and custom endpoints in
 * packages/shared/src/harness-capabilities.ts.
 */
import { faq, feature, type Integration, step } from './types';

const AGENTS_DOCS = '/docs/guides/agents/';

const whereItRunsFaq = (agent: string) =>
  faq(
    `Where does ${agent} run?`,
    `On a cloud VM, inside your repository's devcontainer, using a cloud account connected to your SAM installation. A profile can choose an Instant session on Cloudflare Containers instead, which needs no cloud account but does not use your devcontainer.`
  );

export const agentIntegrations: Integration[] = [
  {
    slug: 'claude-code',
    name: 'Claude Code',
    category: 'ai-agents',
    tagline: 'API key, Claude subscription, or the installation AI proxy',
    description:
      "Anthropic's terminal coding agent. SAM starts it in your workspace, streams its work into project chat, and can run many sessions side by side, each in its own workspace.",
    logoPath: '/images/integrations/anthropic.svg',
    seoTitle: 'Run Claude Code on Your Own Cloud | SAM',
    seoDescription:
      'Run Claude Code agents on cloud VMs you control with SAM, the open-source agent platform. Use an Anthropic API key, a Claude Pro or Max subscription, or an Anthropic-compatible endpoint.',
    features: [
      feature(
        'Three ways to pay',
        "Your Anthropic API key, your Claude Pro or Max subscription (guided sign-in, no terminal), or the installation's AI proxy if your SAM administrator turns it on."
      ),
      feature(
        'Anthropic-compatible endpoints',
        'Point Claude Code at another Anthropic-compatible API, for example a gateway your company already runs.'
      ),
      feature(
        'Several accounts',
        "Connect a work subscription and a client's API key side by side, then pin each to the projects or profiles that should use it."
      ),
      feature(
        'Pull requests when you ask',
        'The agent works on its own branch and pushes it when the task is done. Ask, and it opens a pull request.'
      ),
    ],
    howItWorks: [
      step(
        'Connect an account',
        'In Settings → Agents, sign in with your Claude subscription or paste an API key.'
      ),
      step(
        'Pick a profile',
        'Choose Claude Code and a model in an agent profile, or use the project default.'
      ),
      step(
        'Start a chat or task',
        'SAM places the work on a machine, builds your devcontainer and starts Claude Code.'
      ),
      step(
        'Review the result',
        'Follow along in project chat, steer it while it works, and review the branch or pull request.'
      ),
    ],
    useCases: [
      feature(
        'Parallel feature work',
        'Split a project into tasks and run one agent per task, each in its own workspace and branch.'
      ),
      feature(
        'Large refactors',
        'Describe the pattern once and let several sessions work through different parts of the codebase.'
      ),
      feature(
        'Scheduled and event-driven work',
        'Run Claude Code from a schedule, a GitHub event or a webhook using a saved profile.'
      ),
    ],
    faq: [
      faq(
        'Which models can I choose?',
        'The Claude 5 models, including Claude Fable 5.2, Opus 5.5, Sonnet 5.5 and Haiku 5.5, plus the Claude 4 models. Choose one in an agent profile.'
      ),
      faq(
        'Do I need an Anthropic API key?',
        'No. You can sign in with a Claude Pro or Max subscription instead, or use the installation AI proxy if your administrator has enabled it.'
      ),
      whereItRunsFaq('Claude Code'),
    ],
    relatedSlugs: ['codex', 'opencode', 'github'],
    externalUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    externalLabel: 'Claude Code docs',
    docsPath: AGENTS_DOCS,
    models: ['Claude Fable 5.2', 'Claude Opus 5.5', 'Claude Sonnet 5.5', 'Claude Haiku 5.5'],
  },
  {
    slug: 'codex',
    name: 'OpenAI Codex',
    shortName: 'Codex',
    category: 'ai-agents',
    tagline: 'API key, ChatGPT subscription, or the installation AI proxy',
    description:
      "OpenAI's coding agent, run on your own machines instead of OpenAI's sandbox. SAM installs it in your workspace, keeps its sign-in fresh across parallel sessions, and limits it to the tools your project gives it.",
    logoPath: '/images/integrations/openai.svg',
    seoTitle: 'Run OpenAI Codex on Your Own Cloud | SAM',
    seoDescription:
      'Run OpenAI Codex agents on cloud VMs you control with SAM, the open-source agent platform. Use an OpenAI API key, a ChatGPT subscription, or an OpenAI-compatible endpoint.',
    features: [
      feature(
        'Three ways to pay',
        "Your OpenAI API key, your ChatGPT subscription (guided sign-in with a one-time code), or the installation's AI proxy if your administrator turns it on."
      ),
      feature(
        'Safe token refresh',
        "SAM serializes ChatGPT token refresh per user, so parallel Codex sessions do not invalidate each other's sign-in."
      ),
      feature(
        'Only the tools you give it',
        "SAM turns off Codex's built-in apps and plugins, so a session has only the tools and skills from SAM, your project and your profile."
      ),
      feature(
        'OpenAI-compatible endpoints',
        'Point Codex at another OpenAI-compatible API through a custom base URL.'
      ),
    ],
    howItWorks: [
      step(
        'Connect an account',
        'In Settings → Agents, sign in with ChatGPT or paste an OpenAI API key.'
      ),
      step('Pick a profile', 'Choose Codex and a model in an agent profile.'),
      step(
        'Start a chat or task',
        'SAM places the work on a machine, builds your devcontainer and starts Codex.'
      ),
      step(
        'Review the result',
        'Follow along in project chat and review the branch or pull request.'
      ),
    ],
    useCases: [
      feature(
        'Bug triage in parallel',
        'Turn several bug reports into tasks and let one Codex session investigate each.'
      ),
      feature(
        'Migrations',
        'Framework upgrades, dependency bumps and language version changes, split across sessions.'
      ),
      feature(
        'Second opinion',
        'Run Codex and Claude Code on the same task with different profiles and compare the branches.'
      ),
    ],
    faq: [
      faq(
        'Do I need a ChatGPT subscription?',
        'No. You can use an OpenAI API key, a ChatGPT subscription, or the installation AI proxy if your administrator has enabled it.'
      ),
      faq(
        'Which models can I choose?',
        'GPT-6 Astra, GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Sol, GPT-6 Luna and the GPT-5.6 models. A few older models work only with an API key.'
      ),
      whereItRunsFaq('Codex'),
    ],
    relatedSlugs: ['claude-code', 'opencode', 'github'],
    externalUrl: 'https://developers.openai.com/codex',
    externalLabel: 'Codex docs',
    docsPath: AGENTS_DOCS,
    models: ['GPT-6 Astra', 'GPT-6.1 Sol', 'GPT-6.1 Terra', 'GPT-6 Luna'],
  },
  {
    slug: 'gemini-cli',
    name: 'Gemini CLI',
    category: 'ai-agents',
    tagline: "Google's terminal agent with a Gemini API key",
    description:
      "Google's open-source command-line coding agent. Add a Gemini API key and SAM runs it in your workspace with Gemini 4 and Gemini 3 models.",
    logoPath: '/images/integrations/google-gemini.svg',
    seoTitle: 'Run Gemini CLI on Your Own Cloud | SAM',
    seoDescription:
      'Run Google Gemini CLI agents on cloud VMs you control with SAM, the open-source agent platform. Bring a Gemini API key and choose Gemini 4 or Gemini 3 models.',
    features: [
      feature(
        'Gemini 4 and Gemini 3',
        'Choose Gemini 4 Argon, Gemini 3.8 Flash, Gemini 3.1 Pro Preview or a lighter Flash-Lite model per profile.'
      ),
      feature(
        'API key sign-in',
        'Add a key from Google AI Studio. SAM injects it into the workspace when the agent starts.'
      ),
      feature(
        'Your toolchain',
        "Gemini CLI runs inside your repository's devcontainer with the same runtimes and test tools your team uses."
      ),
    ],
    howItWorks: [
      step('Add your API key', 'Paste a Gemini API key in Settings → Agents.'),
      step('Pick a profile', 'Choose Gemini CLI and a model in an agent profile.'),
      step(
        'Start a chat or task',
        'SAM places the work on a machine and starts Gemini CLI in your devcontainer.'
      ),
    ],
    useCases: [
      feature(
        'Cost-sensitive batches',
        'Use Flash or Flash-Lite models for many small tasks, such as adding types or fixing lint.'
      ),
      feature(
        'Comparing agents',
        'Run the same task with Gemini CLI and another agent and compare the results.'
      ),
    ],
    faq: [
      faq(
        'Which models can I choose?',
        'Gemini 4 Argon and the Gemini 3 models, such as Gemini 3.8 Flash and Gemini 3.1 Pro Preview. Gemini 2.5 remains for existing users until Google retires it.'
      ),
      faq(
        'Can I sign in with a Google account instead of a key?',
        'Not yet. SAM signs Gemini CLI in with a Gemini API key.'
      ),
      whereItRunsFaq('Gemini CLI'),
    ],
    relatedSlugs: ['google-antigravity', 'claude-code', 'gcp'],
    externalUrl: 'https://github.com/google-gemini/gemini-cli',
    externalLabel: 'Gemini CLI on GitHub',
    docsPath: AGENTS_DOCS,
    models: [
      'Gemini 4 Argon',
      'Gemini 3.8 Flash',
      'Gemini 3.1 Pro Preview',
      'Gemini 3.5 Flash-Lite',
    ],
  },
  {
    slug: 'google-antigravity',
    name: 'Google Antigravity',
    shortName: 'Antigravity',
    category: 'ai-agents',
    tagline: "Google's Antigravity agent with Gemini models",
    description:
      "Google's agentic coding tool. SAM downloads the pinned release on first use, checks its SHA-256 digest, signs it in with your Gemini API key and runs it in your workspace or an Instant session.",
    logoPath: '/images/integrations/antigravity.svg',
    seoTitle: 'Run Google Antigravity on Your Own Cloud | SAM',
    seoDescription:
      'Run Google Antigravity coding agents on cloud VMs you control, or in Instant sessions, with SAM. SAM installs a pinned, digest-checked release and signs it in with your Gemini API key.',
    features: [
      feature(
        'Gemini models',
        'Choose Gemini 3.8 Flash, Gemini 3.5 Flash, Gemini 3.1 Pro or another Gemini model Antigravity offers.'
      ),
      feature(
        'Verified install',
        'SAM downloads the pinned release from Google on first use and checks its SHA-256 digest before running it.'
      ),
      feature(
        'Permission modes',
        "SAM's permission modes map to Antigravity's own, so Bypass Permissions runs unattended and Manual asks before acting."
      ),
    ],
    howItWorks: [
      step(
        'Add your API key',
        'Paste a Gemini API key under Google Antigravity in Settings → Agents.'
      ),
      step('Pick a profile', 'Choose Google Antigravity and a Gemini model in an agent profile.'),
      step(
        'Start a chat or task',
        'SAM installs Antigravity on first use and runs your task. The first start downloads about 320 MB.'
      ),
    ],
    useCases: [
      feature(
        "Trying Google's agent on real repositories",
        'Compare Antigravity with Gemini CLI, Claude Code or Codex on the same project without installing anything locally.'
      ),
      feature(
        'Gemini work in parallel',
        'Run several Antigravity sessions at once, each in its own workspace.'
      ),
    ],
    faq: [
      faq(
        'Which models are available?',
        'Gemini models only. Antigravity offers its Claude and GPT models only to clients Google recognizes by name, and SAM is not one of them yet.'
      ),
      faq(
        'Can I send a message while it is working?',
        'Yes. Antigravity cannot take a message into a running turn, so SAM delivers it as the next message when the turn ends.'
      ),
      faq(
        'Does it work on every devcontainer?',
        'It needs Linux x86_64 or arm64 with glibc. Alpine (musl) images are not supported.'
      ),
    ],
    relatedSlugs: ['gemini-cli', 'claude-code', 'gcp'],
    externalUrl: 'https://antigravity.google',
    externalLabel: 'Antigravity website',
    docsPath: AGENTS_DOCS,
    models: ['Gemini 3.8 Flash', 'Gemini 3.5 Flash', 'Gemini 3.1 Pro'],
  },
  {
    slug: 'mistral-vibe',
    name: 'Mistral Vibe',
    shortName: 'Vibe',
    category: 'ai-agents',
    tagline: "Mistral's coding agent with a Mistral API key",
    description:
      "Mistral AI's command-line coding agent. Add a Mistral API key and SAM runs Vibe in your workspace with Mistral Large 3 by default, or Codestral, Mistral Small 4 and the Ministral models.",
    logoPath: '/images/integrations/mistral.svg',
    seoTitle: 'Run Mistral Vibe on Your Own Cloud | SAM',
    seoDescription:
      'Run Mistral Vibe coding agents on cloud VMs you control with SAM, the open-source agent platform. Bring a Mistral API key and choose Mistral Large 3, Codestral or Ministral models.',
    features: [
      feature(
        'Mistral models',
        'Mistral Large 3 by default, Codestral for code-focused work, Mistral Small 4, and Ministral 3 in 14B, 8B and 3B sizes. Z.ai GLM 5.3 is also listed.'
      ),
      feature(
        'API key sign-in',
        'Add a key from the Mistral Console. SAM injects it into the workspace when the agent starts.'
      ),
      feature(
        'Installed with uv',
        'SAM installs Vibe with uv, the Python package manager. uv fetches the Python 3.12 it needs itself.'
      ),
    ],
    howItWorks: [
      step('Add your API key', 'Paste a Mistral API key in Settings → Agents.'),
      step('Pick a profile', 'Choose Mistral Vibe and a model in an agent profile.'),
      step(
        'Start a chat or task',
        'SAM places the work on a machine and starts Vibe in your devcontainer.'
      ),
    ],
    useCases: [
      feature(
        'European model provider',
        "Pair Mistral models with an EU cloud such as Hetzner, Scaleway or Infomaniak. The SAM control plane itself runs on Cloudflare's global network."
      ),
      feature(
        'Small, frequent tasks',
        'Use Ministral or Mistral Small for many cheap tasks and Mistral Large for harder ones.'
      ),
    ],
    faq: [
      faq(
        'Which models can I choose?',
        'Mistral Large 3, Mistral Small 4, Codestral, Ministral 3 (14B, 8B and 3B) and Z.ai GLM 5.3. Mistral Medium 3.5 is listed as deprecated.'
      ),
      faq(
        'Does everything stay in the EU?',
        'Model calls go to Mistral and machines run in the cloud region you choose. Chat history is stored in the Cloudflare account that runs your SAM installation, which is a global network.'
      ),
      whereItRunsFaq('Vibe'),
    ],
    relatedSlugs: ['opencode', 'scaleway', 'infomaniak'],
    externalUrl: 'https://docs.mistral.ai/capabilities/vibe/',
    externalLabel: 'Mistral Vibe docs',
    docsPath: AGENTS_DOCS,
    models: ['Mistral Large 3', 'Codestral', 'Mistral Small 4', 'Ministral 3 14B'],
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    category: 'ai-agents',
    tagline: 'OpenCode Zen, OpenCode Go, or any OpenAI-compatible endpoint',
    description:
      "SST's open-source coding agent. SAM installs a pinned, digest-checked build and runs it against OpenCode Zen, OpenCode Go, or an OpenAI-compatible endpoint you supply, such as a model server you host yourself.",
    logoPath: '/images/integrations/sst.svg',
    seoTitle: 'Run OpenCode on Your Own Cloud | SAM',
    seoDescription:
      'Run OpenCode agents on cloud VMs you control with SAM. Use OpenCode Zen, OpenCode Go, or any OpenAI-compatible endpoint, including one you host yourself.',
    features: [
      feature(
        'Three inference options',
        'OpenCode Zen (the default), OpenCode Go, or a custom OpenAI-compatible endpoint with your own base URL and key.'
      ),
      feature(
        'Live model lists',
        'SAM loads the Zen and Go model lists from Models.dev, with a built-in list if that catalog is unavailable.'
      ),
      feature(
        'Open source end to end',
        'OpenCode is open source, and so is SAM. Your security team can read both.'
      ),
      feature(
        'Pinned, verified build',
        'SAM installs a specific OpenCode release with a SHA-256 check, on glibc and musl images.'
      ),
    ],
    howItWorks: [
      step(
        'Choose an inference provider',
        'In Settings → Agents, pick OpenCode Zen, OpenCode Go, or Custom and enter its key (and base URL for Custom).'
      ),
      step('Pick a profile', 'Choose OpenCode and a model in an agent profile.'),
      step(
        'Start a chat or task',
        'SAM places the work on a machine and starts OpenCode in your devcontainer.'
      ),
    ],
    useCases: [
      feature(
        'Self-hosted models',
        'Point the custom provider at a model server your machines can reach for a setup where prompts never reach a model vendor.'
      ),
      feature(
        'Trying open models',
        'Switch between models on OpenCode Zen and Go without changing your workflow.'
      ),
    ],
    faq: [
      faq(
        'Which inference providers can I use?',
        'OpenCode Zen, OpenCode Go, and any OpenAI-compatible endpoint. Zen and Go use an OpenCode API key.'
      ),
      faq(
        'Is OpenCode the same as OpenAI Codex?',
        'No. OpenCode is a separate open-source project from SST.'
      ),
      faq(
        'Can I use my own fine-tuned model?',
        'Yes, if it is served behind an OpenAI-compatible API. Choose Custom and enter the base URL.'
      ),
    ],
    relatedSlugs: ['codex', 'mistral-vibe', 'claude-code'],
    externalUrl: 'https://opencode.ai',
    externalLabel: 'OpenCode website',
    docsPath: AGENTS_DOCS,
  },
  {
    slug: 'amp',
    name: 'Amp',
    category: 'ai-agents',
    tagline: "Amp's managed coding agent with an Amp API key",
    description:
      'Amp is a coding agent that picks its own models and bills through Amp credits. Add an Amp API key and SAM runs it in your workspace like any other agent.',
    logoPath: '/images/integrations/amp.svg',
    seoTitle: 'Run Amp on Your Own Cloud | SAM',
    seoDescription:
      'Run Amp coding agents on cloud VMs you control with SAM, the open-source agent platform. Bring an Amp API key; SAM provisions the machine and manages the session.',
    features: [
      feature(
        'Managed models',
        'Amp chooses and routes models itself, so there is no model to pick in the profile.'
      ),
      feature('API key sign-in', 'Add a key from your Amp settings. Amp may require paid credits.'),
      feature(
        'Same workflow as other agents',
        'Project chat, profiles, triggers and pull requests work the same way for Amp.'
      ),
    ],
    howItWorks: [
      step('Add your API key', 'Paste an Amp API key in Settings → Agents.'),
      step('Pick a profile', 'Choose Amp in an agent profile.'),
      step(
        'Start a chat or task',
        'SAM places the work on a machine and starts Amp in your devcontainer.'
      ),
    ],
    useCases: [
      feature(
        'Teams already on Amp',
        'Keep Amp as your agent while moving its sessions onto your own machines.'
      ),
      feature('Comparing agents', 'Run Amp alongside Claude Code or Codex on the same project.'),
    ],
    faq: [
      faq("Can I choose Amp's model?", 'No. Amp manages model selection itself.'),
      faq(
        'Does Amp support subscription sign-in in SAM?',
        'No. SAM signs Amp in with an Amp API key.'
      ),
      whereItRunsFaq('Amp'),
    ],
    relatedSlugs: ['claude-code', 'codex', 'opencode'],
    externalUrl: 'https://ampcode.com',
    externalLabel: 'Amp website',
    docsPath: AGENTS_DOCS,
  },
];
