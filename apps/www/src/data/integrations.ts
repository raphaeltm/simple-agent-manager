/**
 * Integration data for all supported technologies.
 * Used by /integrations/ hub page and /integrations/[slug] detail pages.
 */

export interface Integration {
  slug: string;
  name: string;
  shortName?: string;
  category: 'ai-agents' | 'cloud-providers' | 'ai-models';
  categoryLabel: string;
  tagline: string;
  description: string;
  /** Brand color for the logo background */
  color: string;
  /** Path to the logo image file in /images/integrations/ */
  logoPath: string;
  /** SEO-optimized page title */
  seoTitle: string;
  /** SEO meta description (max ~155 chars) */
  seoDescription: string;
  features: Array<{ title: string; description: string }>;
  howItWorks: Array<{ step: string; description: string }>;
  useCases: Array<{ title: string; description: string }>;
  faq: Array<{ question: string; answer: string }>;
  relatedSlugs: string[];
  /** External link to the technology's website */
  externalUrl: string;
  /** Optional models supported by this agent */
  models?: string[];
}

export const categories = [
  { id: 'ai-agents' as const, label: 'AI Coding Agents', description: 'Run any coding agent on your infrastructure' },
  { id: 'cloud-providers' as const, label: 'Cloud Providers', description: 'Bring your own cloud — your VMs, your data' },
  { id: 'ai-models' as const, label: 'AI Models', description: 'Use the best model for every task' },
] as const;

export const integrations: Integration[] = [
  // ─── AI CODING AGENTS ──────────────────────────────────────────────
  {
    slug: 'claude-code',
    name: 'Claude Code',
    category: 'ai-agents',
    categoryLabel: 'AI Coding Agents',
    tagline: 'Run Claude Code agents in parallel on your infrastructure',
    description:
      "Claude Code by Anthropic is an agentic coding tool that lives in your terminal. With SAM, you can run dozens of Claude Code instances in parallel across cloud VMs — each in its own isolated devcontainer with full access to your repo's toolchain.",
    color: '#CC785C',
    logoPath: '/images/integrations/anthropic.svg',
    seoTitle: 'Run Claude Code in the Cloud | SAM',
    seoDescription:
      'Run Claude Code agents in parallel on your own cloud VMs. SAM orchestrates Anthropic\'s Claude Code with isolated devcontainers, lifecycle management, and automatic PR creation.',
    features: [
      { title: 'Parallel Execution', description: 'Run dozens of Claude Code instances simultaneously, each tackling a different task or feature branch.' },
      { title: 'Dual Auth Support', description: 'Bring your Anthropic API key or use a Claude Max/Pro OAuth subscription — SAM handles both seamlessly.' },
      { title: 'Full Tool Access', description: 'Claude Code gets full Read, Edit, Bash, and other tool access inside the devcontainer, just like running it locally.' },
      { title: 'Automatic PR Creation', description: 'When the agent finishes, SAM pushes changes and opens a pull request on your repo automatically.' },
    ],
    howItWorks: [
      { step: 'Create a Project', description: 'Link your GitHub repository and configure Claude Code as your agent.' },
      { step: 'Submit a Task', description: 'Describe what you want built — a feature, bug fix, refactor, or test suite.' },
      { step: 'SAM Provisions & Runs', description: 'SAM spins up a cloud VM, builds your devcontainer, and launches Claude Code with your task.' },
      { step: 'Review the PR', description: 'Claude Code commits its work, pushes a branch, and opens a pull request for your review.' },
    ],
    useCases: [
      { title: 'Parallelize feature development', description: 'Break a large project into tasks and run an agent on each simultaneously. Ship a week of work in hours.' },
      { title: 'Automate refactoring', description: 'Point Claude Code at a codebase and describe the refactoring pattern. It handles the mechanical work across hundreds of files.' },
      { title: 'Run test generation at scale', description: 'Generate comprehensive test suites for existing code — Claude Code understands your codebase context and writes meaningful tests.' },
    ],
    faq: [
      { question: 'What models does Claude Code use?', answer: 'Claude Code uses Anthropic\'s Claude models. SAM supports configuring the model per project — including Claude Opus, Sonnet, and Haiku variants.' },
      { question: 'Do I need an Anthropic API key?', answer: 'You can use either an Anthropic API key (pay-per-use) or a Claude Max/Pro OAuth token (subscription-based). Configure your preferred method in project settings.' },
      { question: 'Can I run Claude Code in a devcontainer?', answer: 'Yes — SAM builds your repo\'s devcontainer on the VM. Claude Code runs inside it with the same toolchains, language runtimes, and test runners your team uses.' },
    ],
    relatedSlugs: ['codex', 'hetzner', 'scaleway'],
    externalUrl: 'https://docs.anthropic.com/en/docs/claude-code/overview',
    models: ['Claude Opus 4', 'Claude Sonnet 4', 'Claude Haiku 4.5'],
  },
  {
    slug: 'codex',
    name: 'OpenAI Codex',
    shortName: 'Codex',
    category: 'ai-agents',
    categoryLabel: 'AI Coding Agents',
    tagline: 'Run OpenAI Codex agents in cloud workspaces',
    description:
      "OpenAI Codex is a cloud-native coding agent that writes and executes code in a sandboxed environment. With SAM, you can run Codex on your own infrastructure — keeping your code on your VMs while leveraging OpenAI's latest models.",
    color: '#000000',
    logoPath: '/images/integrations/openai.svg',
    seoTitle: 'Run OpenAI Codex on Your Infrastructure | SAM',
    seoDescription:
      'Run OpenAI Codex coding agents on your own cloud VMs. SAM handles provisioning, devcontainer setup, and lifecycle management for Codex workspaces.',
    features: [
      { title: 'Your Infrastructure', description: 'Codex runs on your cloud VMs instead of OpenAI\'s sandbox — giving you full control over compute, data residency, and costs.' },
      { title: 'OAuth Token Management', description: 'SAM manages Codex OAuth token refresh automatically — including concurrent session handling to prevent token race conditions.' },
      { title: 'Full GPT Model Access', description: 'Use the latest GPT models including GPT-5, o3, and o4-mini for different coding tasks.' },
      { title: 'Devcontainer Integration', description: 'Codex works inside your repo\'s devcontainer — no separate Docker setup needed.' },
    ],
    howItWorks: [
      { step: 'Connect Your Account', description: 'Add your OpenAI API key or Codex OAuth credentials in project settings.' },
      { step: 'Choose Codex as Agent', description: 'Select OpenAI Codex from the agent dropdown when creating a project or submitting a task.' },
      { step: 'Submit Tasks', description: 'Describe your coding task in natural language. SAM provisions a VM and runs Codex.' },
      { step: 'Get Results', description: 'Codex completes the work, and SAM pushes changes to a branch with a pull request.' },
    ],
    useCases: [
      { title: 'Code generation at scale', description: 'Use Codex to generate boilerplate, API clients, or data models across multiple repositories simultaneously.' },
      { title: 'Bug fix triage', description: 'Submit multiple bug reports as tasks and let Codex investigate and fix each one in parallel.' },
      { title: 'Migration assistance', description: 'Let Codex handle framework migrations, dependency updates, or language version upgrades across your codebase.' },
    ],
    faq: [
      { question: 'Do I need a ChatGPT Pro subscription?', answer: 'You can use either an OpenAI API key or a ChatGPT Pro/Plus OAuth token. SAM supports both authentication methods.' },
      { question: 'How does SAM handle Codex token refresh?', answer: 'SAM includes a centralized refresh proxy that serializes token rotation per user, preventing race conditions when multiple Codex instances run concurrently.' },
      { question: 'What models can Codex use?', answer: 'Codex supports GPT-5 variants (5.4, 5.3, 5.2, 5.1), GPT-4.1, o3, and o4-mini. You can configure the model per project.' },
    ],
    relatedSlugs: ['claude-code', 'gemini-cli', 'hetzner'],
    externalUrl: 'https://openai.com/index/introducing-codex/',
    models: ['GPT-5', 'GPT-4.1', 'o3', 'o4-mini'],
  },
  {
    slug: 'gemini-cli',
    name: 'Gemini CLI',
    shortName: 'Gemini CLI',
    category: 'ai-agents',
    categoryLabel: 'AI Coding Agents',
    tagline: 'Run Google Gemini CLI agents on your cloud VMs',
    description:
      "Google's Gemini CLI brings Gemini's multimodal capabilities to the command line for coding tasks. SAM orchestrates Gemini CLI on your infrastructure, giving you access to Google's most capable models in isolated cloud environments.",
    color: '#1A73E8',
    logoPath: '/images/integrations/google-gemini.svg',
    seoTitle: 'Run Gemini CLI in Cloud Workspaces | SAM',
    seoDescription:
      'Run Google Gemini CLI coding agents on your own infrastructure. SAM provisions VMs, builds devcontainers, and manages agent lifecycles for Gemini CLI.',
    features: [
      { title: 'Multimodal Coding', description: 'Gemini CLI can understand images, diagrams, and screenshots alongside code — useful for UI implementation tasks.' },
      { title: 'Gemini 2.5 Models', description: 'Access Gemini 2.5 Pro and Flash models for different cost/performance tradeoffs.' },
      { title: 'Large Context Windows', description: 'Gemini models support massive context windows, ideal for understanding large codebases.' },
      { title: 'Google API Key Auth', description: 'Simple API key authentication — add your Gemini API key and start running agents.' },
    ],
    howItWorks: [
      { step: 'Add Your API Key', description: 'Enter your Google Gemini API key in SAM settings.' },
      { step: 'Select Gemini CLI', description: 'Choose Gemini CLI as the agent for your project.' },
      { step: 'Describe Your Task', description: 'Submit a task with a natural language description of what you need built.' },
      { step: 'Agent Executes', description: 'SAM provisions a VM, builds the devcontainer, installs Gemini CLI, and runs your task.' },
    ],
    useCases: [
      { title: 'UI implementation from designs', description: 'Upload mockups and screenshots — Gemini CLI\'s multimodal capabilities let it implement UI from visual references.' },
      { title: 'Large codebase analysis', description: 'Use Gemini\'s massive context window to analyze and refactor large codebases in a single session.' },
      { title: 'Cross-language projects', description: 'Gemini handles polyglot codebases well — ideal for projects mixing TypeScript, Python, Go, and other languages.' },
    ],
    faq: [
      { question: 'Which Gemini models are supported?', answer: 'SAM supports Gemini 2.5 Pro, Gemini 2.5 Flash, and Gemini 2.0 Flash. Configure the model in your project settings.' },
      { question: 'Is Gemini CLI free to use?', answer: 'Gemini CLI requires a Google Gemini API key. Google offers free tier usage with rate limits. SAM itself doesn\'t charge extra for using Gemini CLI.' },
      { question: 'Can Gemini CLI work with devcontainers?', answer: 'Yes — Gemini CLI runs inside your repo\'s devcontainer on the provisioned VM, with full access to your project\'s tools and dependencies.' },
    ],
    relatedSlugs: ['claude-code', 'mistral-vibe', 'gcp'],
    externalUrl: 'https://github.com/google-gemini/gemini-cli',
    models: ['Gemini 2.5 Pro', 'Gemini 2.5 Flash', 'Gemini 2.0 Flash'],
  },
  {
    slug: 'mistral-vibe',
    name: 'Mistral Vibe',
    shortName: 'Vibe',
    category: 'ai-agents',
    categoryLabel: 'AI Coding Agents',
    tagline: 'Run Mistral Vibe coding agents at scale',
    description:
      "Mistral Vibe is Mistral AI's agentic coding tool, powered by Devstral — a model purpose-built for software engineering. With SAM, you can run dozens of Vibe agents in parallel on your own cloud, each working on a different coding task.",
    color: '#FF6B35',
    logoPath: '/images/integrations/mistral.svg',
    seoTitle: 'Run Mistral Vibe Agents in Parallel | SAM',
    seoDescription:
      'Run Mistral Vibe coding agents in parallel on your own cloud. SAM orchestrates Devstral-powered Vibe agents with full devcontainer support and automatic PR creation.',
    features: [
      { title: 'Devstral Models', description: 'Vibe is powered by Devstral — Mistral\'s coding-specialized model available in 24B and 123B parameter sizes.' },
      { title: 'Python-Based Agent', description: 'Installed via uv (Python package manager), Vibe integrates smoothly with Python-heavy codebases and toolchains.' },
      { title: 'Cost-Effective Scaling', description: 'Devstral models offer strong coding performance at competitive prices — ideal for running many agents simultaneously.' },
      { title: 'European AI Option', description: 'Mistral is a European AI company — an important option for teams with data residency considerations.' },
    ],
    howItWorks: [
      { step: 'Add Mistral API Key', description: 'Enter your Mistral API key in SAM settings.' },
      { step: 'Select Mistral Vibe', description: 'Choose Mistral Vibe as the agent for your project or task.' },
      { step: 'Submit Tasks', description: 'Describe coding tasks in natural language — bug fixes, features, refactors, tests.' },
      { step: 'Parallel Execution', description: 'SAM provisions VMs and runs Vibe agents in parallel, each in its own devcontainer.' },
    ],
    useCases: [
      { title: 'Cost-efficient batch processing', description: 'Run dozens of coding tasks simultaneously with Devstral Small — great for repetitive work like adding types, fixing linting, or writing tests.' },
      { title: 'Python ecosystem work', description: 'Vibe excels with Python projects — migrations, refactoring, and building data pipelines.' },
      { title: 'EU data compliance', description: 'For teams requiring European data processing, using Mistral as your AI provider paired with European cloud providers (Hetzner, Scaleway) keeps everything in the EU.' },
    ],
    faq: [
      { question: 'What is Devstral?', answer: 'Devstral is Mistral AI\'s coding-specialized model family. Devstral 2 (123B) is the flagship, and Devstral Small 2 (24B) offers a cost-effective alternative.' },
      { question: 'How does Vibe compare to Claude Code?', answer: 'Both are capable coding agents. Vibe is powered by Mistral\'s Devstral models and tends to be more cost-effective for batch operations. Claude Code uses Anthropic\'s Claude models and has deeper tool integration.' },
      { question: 'Can I use Vibe with Codestral?', answer: 'Yes — SAM supports configuring Codestral 25.08, Mistral Large 3, and other Mistral models alongside the default Devstral models.' },
    ],
    relatedSlugs: ['claude-code', 'opencode', 'scaleway'],
    externalUrl: 'https://docs.mistral.ai/capabilities/vibe/',
    models: ['Devstral 2 (123B)', 'Devstral Small 2 (24B)', 'Codestral', 'Mistral Large 3'],
  },
  {
    slug: 'opencode',
    name: 'OpenCode',
    category: 'ai-agents',
    categoryLabel: 'AI Coding Agents',
    tagline: 'Run OpenCode agents with any inference provider',
    description:
      "OpenCode is an open-source AI coding agent from SST that works with multiple inference providers. With SAM, you can run OpenCode on your cloud VMs using Scaleway, Google Vertex, Anthropic, or any OpenAI-compatible API as the backend.",
    color: '#6366F1',
    logoPath: '/images/integrations/sst.svg',
    seoTitle: 'Run OpenCode with Any AI Provider | SAM',
    seoDescription:
      'Run OpenCode agents on your cloud with any inference provider — Scaleway, Google Vertex, Anthropic, or custom endpoints. SAM handles VM provisioning and agent lifecycle.',
    features: [
      { title: 'Provider Flexibility', description: 'Use any OpenAI-compatible inference provider — Scaleway, Google Vertex, Anthropic, or your own endpoint.' },
      { title: 'Open Source', description: 'OpenCode is fully open source (from SST), so you can audit, modify, and extend the agent to fit your needs.' },
      { title: 'Lightweight Footprint', description: 'Minimal resource requirements mean you can run more OpenCode instances on smaller VMs.' },
      { title: 'Scaleway Native', description: 'First-class integration with Scaleway\'s inference API — a natural pairing with SAM\'s Scaleway cloud provider support.' },
    ],
    howItWorks: [
      { step: 'Configure Provider', description: 'Set your inference provider credentials — Scaleway API key, Google Vertex config, or a custom endpoint.' },
      { step: 'Select OpenCode', description: 'Choose OpenCode as the agent for your project.' },
      { step: 'Submit a Task', description: 'Describe your coding task. SAM provisions a VM and launches OpenCode.' },
      { step: 'Agent Delivers', description: 'OpenCode completes the work, and SAM commits and pushes the changes.' },
    ],
    useCases: [
      { title: 'Self-hosted AI stack', description: 'Pair OpenCode with a self-hosted inference endpoint for a fully private AI coding setup — no data leaves your infrastructure.' },
      { title: 'Scaleway-native development', description: 'Use Scaleway for both compute (VMs) and inference (Scaleway AI) — a unified European cloud stack.' },
      { title: 'Custom model experimentation', description: 'Test different models and providers by swapping OpenCode\'s inference backend without changing your workflow.' },
    ],
    faq: [
      { question: 'What inference providers work with OpenCode?', answer: 'OpenCode supports Scaleway, Google Vertex AI, Anthropic, and any OpenAI-compatible endpoint. Configure the provider in your project settings.' },
      { question: 'Is OpenCode the same as OpenAI Codex?', answer: 'No — OpenCode is a separate open-source project from SST. It\'s a different agent that happens to support multiple AI providers including (but not limited to) OpenAI-compatible APIs.' },
      { question: 'Can I use my own fine-tuned models?', answer: 'Yes — if your model is served via an OpenAI-compatible API endpoint, OpenCode can use it. Point the inference URL to your custom endpoint.' },
    ],
    relatedSlugs: ['mistral-vibe', 'scaleway', 'gemini-cli'],
    externalUrl: 'https://opencode.ai',
  },

  // ─── CLOUD PROVIDERS ───────────────────────────────────────────────
  {
    slug: 'hetzner',
    name: 'Hetzner Cloud',
    shortName: 'Hetzner',
    category: 'cloud-providers',
    categoryLabel: 'Cloud Providers',
    tagline: 'Run coding agents on affordable Hetzner Cloud VMs',
    description:
      "Hetzner Cloud offers high-performance, affordable VMs across Europe and the US. As SAM's original and most battle-tested cloud provider, Hetzner gives you excellent compute value for running AI coding agents at scale.",
    color: '#D50C2D',
    logoPath: '/images/integrations/hetzner.svg',
    seoTitle: 'Run AI Coding Agents on Hetzner Cloud | SAM',
    seoDescription:
      'Run AI coding agents on affordable Hetzner Cloud VMs. SAM handles provisioning, devcontainer setup, and lifecycle management on your Hetzner account.',
    features: [
      { title: 'Unbeatable Pricing', description: 'Hetzner offers some of the most affordable cloud VMs available — run more agents for less.' },
      { title: 'European & US Regions', description: 'Nuremberg, Falkenstein, Helsinki, Ashburn, and Hillsboro — choose the region closest to your team.' },
      { title: 'Battle-Tested Integration', description: 'Hetzner is SAM\'s original cloud provider — the most mature and thoroughly tested integration.' },
      { title: 'Simple API Key Auth', description: 'Generate an API token in the Hetzner Cloud Console and add it to SAM. No IAM complexity.' },
    ],
    howItWorks: [
      { step: 'Get a Hetzner API Token', description: 'Create a project in Hetzner Cloud Console and generate an API token.' },
      { step: 'Add Token to SAM', description: 'Paste your Hetzner API token in SAM settings. It\'s encrypted and stored per-user.' },
      { step: 'Choose a Location', description: 'Select from European or US data centers for your VMs.' },
      { step: 'Start Running Agents', description: 'Submit tasks and SAM provisions Hetzner VMs automatically. Pay only for compute time used.' },
    ],
    useCases: [
      { title: 'Cost-effective agent scaling', description: 'Hetzner\'s pricing lets you run 5-10 concurrent agents for the cost of one agent on major cloud providers.' },
      { title: 'EU data sovereignty', description: 'Hetzner\'s European data centers keep your code and agent operations within the EU.' },
      { title: 'Getting started quickly', description: 'The simplest cloud provider to set up with SAM — just an API token. No IAM roles, no service accounts, no billing APIs.' },
    ],
    faq: [
      { question: 'How much does Hetzner cost?', answer: 'Hetzner VMs start at a few cents per hour. SAM provisions VMs on demand and can clean them up automatically, so you only pay for actual compute time.' },
      { question: 'Do I need a Hetzner account?', answer: 'Yes — SAM uses a BYOC (Bring Your Own Cloud) model. You create a Hetzner Cloud project, generate an API token, and add it to SAM.' },
      { question: 'Is my Hetzner token secure?', answer: 'Your token is encrypted with AES-GCM and stored per-user in the database. SAM never stores cloud provider credentials as plain text or environment variables.' },
    ],
    relatedSlugs: ['scaleway', 'claude-code', 'codex'],
    externalUrl: 'https://www.hetzner.com/cloud/',
  },
  {
    slug: 'scaleway',
    name: 'Scaleway',
    category: 'cloud-providers',
    categoryLabel: 'Cloud Providers',
    tagline: 'Run coding agents on Scaleway cloud infrastructure',
    description:
      "Scaleway is a European cloud provider offering compute, storage, and AI inference services. With SAM, you can run coding agents on Scaleway VMs across Paris, Amsterdam, and Warsaw — and even pair them with Scaleway's native AI inference for a fully European AI stack.",
    color: '#4F0599',
    logoPath: '/images/integrations/scaleway.svg',
    seoTitle: 'Run AI Agents on Scaleway Infrastructure | SAM',
    seoDescription:
      'Run AI coding agents on Scaleway VMs in Paris, Amsterdam, and Warsaw. SAM provisions workspaces on your Scaleway account with full BYOC control.',
    features: [
      { title: 'European Data Centers', description: 'Paris, Amsterdam, and Warsaw — keep your code and agent operations within the EU.' },
      { title: 'AI Inference Pairing', description: 'Scaleway offers its own AI inference API — pair it with OpenCode for a fully Scaleway-native AI coding stack.' },
      { title: 'Competitive Pricing', description: 'Scaleway offers competitive VM pricing with flexible instance types suited for coding workloads.' },
      { title: 'BYOC Integration', description: 'Bring your Scaleway credentials — SAM encrypts and stores them per-user for secure provisioning.' },
    ],
    howItWorks: [
      { step: 'Get Scaleway Credentials', description: 'Generate API keys in the Scaleway Console.' },
      { step: 'Add to SAM', description: 'Enter your Scaleway credentials in SAM settings. They\'re encrypted and stored per-user.' },
      { step: 'Pick a Region', description: 'Choose from Paris, Amsterdam, or Warsaw data centers.' },
      { step: 'Run Agents', description: 'Submit coding tasks and SAM provisions Scaleway VMs automatically.' },
    ],
    useCases: [
      { title: 'Full European AI stack', description: 'Scaleway VMs + Scaleway AI inference + Mistral Vibe = a fully European, GDPR-friendly AI coding pipeline.' },
      { title: 'Multi-cloud redundancy', description: 'Use Scaleway alongside Hetzner for geographic distribution and provider redundancy.' },
      { title: 'AI inference flexibility', description: 'Scaleway\'s inference API supports multiple models — pair with OpenCode for maximum flexibility.' },
    ],
    faq: [
      { question: 'Which Scaleway regions does SAM support?', answer: 'SAM supports Paris (fr-par-1, fr-par-2, fr-par-3), Amsterdam (nl-ams-1, nl-ams-2, nl-ams-3), and Warsaw (pl-waw-1, pl-waw-2).' },
      { question: 'Can I use Scaleway inference with SAM?', answer: 'Yes — use OpenCode as your agent and configure it to use Scaleway\'s inference API as the backend. This creates a fully Scaleway-native stack.' },
      { question: 'How does Scaleway compare to Hetzner?', answer: 'Both are excellent European providers. Hetzner tends to be cheaper for raw compute. Scaleway offers additional services like managed inference that can complement SAM.' },
    ],
    relatedSlugs: ['hetzner', 'opencode', 'mistral-vibe'],
    externalUrl: 'https://www.scaleway.com/',
  },
  {
    slug: 'gcp',
    name: 'Google Cloud Platform',
    shortName: 'GCP',
    category: 'cloud-providers',
    categoryLabel: 'Cloud Providers',
    tagline: 'Run coding agents on Google Cloud infrastructure',
    description:
      "Google Cloud Platform provides global infrastructure with enterprise-grade security. SAM integrates with GCP using Workload Identity Federation — no long-lived credentials needed. Run coding agents on Compute Engine VMs across 8 regions worldwide.",
    color: '#4285F4',
    logoPath: '/images/integrations/gcp.svg',
    seoTitle: 'Run AI Coding Agents on Google Cloud | SAM',
    seoDescription:
      'Run AI coding agents on Google Cloud VMs with Workload Identity Federation. SAM provisions Compute Engine instances across 8 global regions.',
    features: [
      { title: 'Workload Identity Federation', description: 'No long-lived service account keys — SAM uses GCP\'s WIF for secure, short-lived credential exchange.' },
      { title: 'Global Regions', description: 'Iowa, South Carolina, Oregon, Belgium, Frankfurt, London, Singapore, and Tokyo — true global coverage.' },
      { title: 'Enterprise Security', description: 'GCP\'s IAM, audit logging, and compliance certifications for organizations with strict security requirements.' },
      { title: 'Compute Engine Integration', description: 'SAM provisions Compute Engine VMs with the right machine types for coding agent workloads.' },
    ],
    howItWorks: [
      { step: 'Set Up WIF', description: 'Configure a Workload Identity Pool and Provider in your GCP project following SAM\'s setup guide.' },
      { step: 'Connect to SAM', description: 'Enter your GCP project ID, WIF pool details, and service account in SAM settings.' },
      { step: 'Choose a Region', description: 'Select from 8 global regions for your VMs.' },
      { step: 'Run Agents', description: 'Submit tasks and SAM provisions Compute Engine VMs using short-lived WIF credentials.' },
    ],
    useCases: [
      { title: 'Enterprise deployments', description: 'For organizations already on GCP with existing IAM policies, security controls, and compliance requirements.' },
      { title: 'Global team distribution', description: 'GCP\'s 8 regions let you run agents close to your team — regardless of where they are in the world.' },
      { title: 'Google ecosystem integration', description: 'Pair with Gemini CLI and Google\'s AI models for a fully Google-native coding agent stack.' },
    ],
    faq: [
      { question: 'What is Workload Identity Federation?', answer: 'WIF lets SAM exchange short-lived tokens with GCP without storing long-lived service account keys. It\'s Google\'s recommended approach for third-party integrations.' },
      { question: 'Which GCP machine types does SAM use?', answer: 'SAM provisions standard Compute Engine instances optimized for coding workloads. You can configure the VM size per project.' },
      { question: 'Do I need a GCP billing account?', answer: 'Yes — SAM uses a BYOC model. VMs are provisioned on your GCP project, and you pay Google directly for compute usage.' },
    ],
    relatedSlugs: ['hetzner', 'gemini-cli', 'claude-code'],
    externalUrl: 'https://cloud.google.com/',
  },

  // ─── AI MODELS / PLATFORMS ─────────────────────────────────────────
  {
    slug: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    shortName: 'Workers AI',
    category: 'ai-models',
    categoryLabel: 'AI Models',
    tagline: 'Free AI inference built into the platform',
    description:
      "SAM runs on Cloudflare Workers, and Workers AI provides free AI inference at the edge. SAM uses Workers AI for task title generation, text-to-speech, and context summarization — all included with the platform at no extra cost.",
    color: '#F6821F',
    logoPath: '/images/integrations/cloudflare.svg',
    seoTitle: 'Free AI with Cloudflare Workers AI | SAM',
    seoDescription:
      'SAM includes free AI inference via Cloudflare Workers AI — task titles, text-to-speech, and summarization at no extra cost. Built into the platform.',
    features: [
      { title: 'Zero Extra Cost', description: 'Workers AI inference is included with SAM — no API keys needed for built-in features like task titles and TTS.' },
      { title: 'Edge Inference', description: 'Models run at Cloudflare\'s edge — low latency for platform features, no cold starts.' },
      { title: 'Multiple Models', description: 'Llama 4, Gemma 3, Qwen 3, and Deepgram for different tasks — SAM picks the right model automatically.' },
      { title: 'AI Gateway', description: 'All inference is routed through Cloudflare AI Gateway for rate limiting, analytics, and reliability.' },
    ],
    howItWorks: [
      { step: 'Already Built In', description: 'Workers AI is part of SAM\'s Cloudflare infrastructure — no setup required.' },
      { step: 'Automatic Model Selection', description: 'SAM uses the right model for each task: Gemma for titles, Deepgram for TTS, Llama for summarization.' },
      { step: 'AI Proxy (Optional)', description: 'Enable the AI proxy to route custom inference through Workers AI with rate limiting and token budgets.' },
      { step: 'Monitor Usage', description: 'Track AI usage, costs, and model distribution via the admin analytics dashboard.' },
    ],
    useCases: [
      { title: 'Zero-config AI features', description: 'Task title generation, text-to-speech for messages, and context summarization work out of the box.' },
      { title: 'AI proxy gateway', description: 'Route LLM requests through SAM\'s AI proxy for rate limiting, token budgets, and centralized analytics.' },
      { title: 'Self-hosted AI platform', description: 'When self-hosting SAM on Cloudflare\'s free tier, Workers AI provides AI capabilities without any API key costs.' },
    ],
    faq: [
      { question: 'Is Workers AI really free?', answer: 'Yes — Cloudflare provides a generous free tier for Workers AI inference. SAM\'s built-in features (task titles, TTS, summarization) use this free tier.' },
      { question: 'Can I use Workers AI for my coding agents?', answer: 'Workers AI powers platform features, not the coding agents themselves. Agents use their own models (Claude, GPT, Gemini, Devstral) via their respective API keys.' },
      { question: 'What models does SAM use?', answer: 'Llama 4 Scout 17B for general inference, Gemma 3 12B for task titles, Qwen 3 30B for complex tasks, and Deepgram Aura 2 for text-to-speech.' },
    ],
    relatedSlugs: ['claude-code', 'codex', 'gemini-cli'],
    externalUrl: 'https://ai.cloudflare.com/',
  },
  {
    slug: 'github',
    name: 'GitHub',
    category: 'ai-models',
    categoryLabel: 'AI Models',
    tagline: 'Deep GitHub integration for repository management',
    description:
      "SAM integrates deeply with GitHub for repository access, authentication, and pull request management. Install the SAM GitHub App on your repos, and agents can clone code, push branches, and open PRs — all with proper GitHub permissions.",
    color: '#24292F',
    logoPath: '/images/integrations/github.svg',
    seoTitle: 'GitHub Integration for AI Coding Agents | SAM',
    seoDescription:
      'Connect your GitHub repos to SAM for automatic agent provisioning, branch management, and pull request creation. GitHub App integration with proper permissions.',
    features: [
      { title: 'GitHub App Integration', description: 'Install the SAM GitHub App for secure repository access — proper permissions without sharing personal tokens.' },
      { title: 'Automatic PR Creation', description: 'Agents push to descriptive branches and open pull requests automatically when work is complete.' },
      { title: 'Repository Discovery', description: 'SAM discovers your repos via the GitHub App installation — select a repo when creating a project.' },
      { title: 'OAuth Login', description: 'Sign in to SAM with your GitHub account — no separate account needed.' },
    ],
    howItWorks: [
      { step: 'Sign In with GitHub', description: 'Authenticate to SAM using your GitHub account via OAuth.' },
      { step: 'Install the GitHub App', description: 'Install SAM\'s GitHub App on your organization or personal repos.' },
      { step: 'Create a Project', description: 'Select a repository from your installations to create a SAM project.' },
      { step: 'Agents Use GitHub', description: 'Agents clone, branch, commit, push, and open PRs using the GitHub App\'s credentials.' },
    ],
    useCases: [
      { title: 'Automated PR workflows', description: 'Submit tasks and get pull requests. Agents create descriptive branches (sam/...), commit meaningful changes, and open PRs for your review.' },
      { title: 'Multi-repo orchestration', description: 'Create projects for different repos and run agents across your entire codebase simultaneously.' },
      { title: 'Open source contribution', description: 'Use SAM to help maintain open source projects — triage issues, fix bugs, and generate PRs at scale.' },
    ],
    faq: [
      { question: 'What GitHub permissions does SAM need?', answer: 'The SAM GitHub App requests repository read/write access for code, pull requests, and issues. You choose exactly which repos to grant access to.' },
      { question: 'Can SAM work with GitHub Enterprise?', answer: 'SAM is designed for GitHub.com. GitHub Enterprise Server support is on the roadmap for self-hosted deployments.' },
      { question: 'Do agents use my GitHub token?', answer: 'No — agents use the GitHub App\'s installation token for repository operations. Your personal OAuth token is only used for authentication to SAM itself.' },
    ],
    relatedSlugs: ['claude-code', 'codex', 'hetzner'],
    externalUrl: 'https://github.com',
  },
];

/** Get all integrations for a specific category */
export function getByCategory(categoryId: string): Integration[] {
  return integrations.filter((i) => i.category === categoryId);
}

/** Get a single integration by slug */
export function getBySlug(slug: string): Integration | undefined {
  return integrations.find((i) => i.slug === slug);
}

/** Get related integrations for a given integration */
export function getRelated(integration: Integration): Integration[] {
  return integration.relatedSlugs
    .map((slug) => getBySlug(slug))
    .filter((i): i is Integration => i !== undefined);
}
