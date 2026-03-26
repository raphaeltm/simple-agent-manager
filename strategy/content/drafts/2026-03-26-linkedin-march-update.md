# LinkedIn Post — March 2026 Update

**Target**: LinkedIn
**Theme**: Pace of development with AI agents building the platform, key features shipped
**Style Reference**: `strategy/content/style-guide-raph.md`
**Note**: Variants below. Raph should add a personal hook if one fits naturally.

---

## Variant A — "The agents are building SAM" angle

548 commits merged to main this month on SAM. 109 of them are features.

I didn't write most of them. My AI agents did.

SAM is an open-source platform for running AI coding agents on your own cloud. The meta part: I use SAM to build SAM. I submit a task describing what I want, an agent spins up a workspace on my Hetzner account, writes the code, opens a PR, deploys to staging, verifies it works, and merges. I review. Sometimes I just watch.

Here's what shipped in March:

- Ideas system. Replaced the task board with something closer to how I actually think about work. You drop an idea, the agents can pick it up, conversations get linked automatically.
- GCP OIDC deployments. Connect your Google Cloud account via OAuth, agents deploy your code with short-lived tokens. No static service account keys.
- Security hardening. Split encryption keys by purpose, scoped callback tokens per-workspace, blocked container access to cloud metadata APIs, prevented shell injection in env vars. The kind of stuff you don't notice until it matters.
- Chat UX. Virtual scrolling for long conversations, full-text search across message history, auto-resume when sessions drop, slash command caching.
- Multi-agent, multi-cloud. Scaleway as a second cloud provider. Mistral Vibe, OpenAI Codex, and Google Gemini alongside Claude Code. Four agents, two clouds, pick per project.

The weirdest part of this month: reading post-mortems written by agents about bugs introduced by other agents, then watching a third agent implement the fix. I mostly just set direction and review.

Open source: github.com/raphaeltm/simple-agent-manager

---

## Variant B — "What 109 features in a month looks like" angle

109 features merged in March. One developer. A lot of AI agents.

I've been building SAM, an open-source platform for running AI coding agents on your own cloud. The thing that makes this pace possible is that SAM builds itself. I describe what I want in a chat, an agent provisions a workspace, writes code, tests it, deploys to staging, and merges the PR. I review the output. Sometimes I steer. Often I just approve.

What shipped:

An ideas system that replaced the old task board. You capture an idea, agents can execute on it, conversations link automatically. Closer to how work actually starts.

GCP OIDC for deployments. Agents can deploy to Google Cloud using short-lived tokens from an OAuth flow. No long-lived service account keys sitting in env vars.

A bunch of security work. Purpose-specific encryption keys. Workspace-scoped callback tokens. Cloud metadata API blocking. Shell injection prevention. XSS hardening. The boring-sounding stuff that keeps multi-tenant infrastructure safe.

Four AI agents (Claude Code, Mistral Vibe, OpenAI Codex, Google Gemini) on two cloud providers (Hetzner, Scaleway). Pick per project.

Chat improvements. Virtual scrolling, full-text search across all conversations, auto-resume on dropped sessions.

548 total commits. Most of them written by agents running on the platform they're building.

Open source: github.com/raphaeltm/simple-agent-manager

---

## Variant C — Shorter, punchier

SAM shipped 109 features in March. One person. Many AI agents.

SAM is an open-source platform for running AI coding agents on your own cloud. I use it to build itself. Describe what I want, an agent writes the code, deploys it, verifies it works, opens a PR.

This month: an ideas system for capturing and executing on rough plans. GCP OIDC so agents can deploy to Google Cloud with short-lived tokens. Security hardening across the board (split encryption keys, scoped tokens, metadata API blocking). Four AI agents on two cloud providers. Full-text search across conversation history. 548 commits total.

The platform builds the platform. That's the whole idea.

Open source: github.com/raphaeltm/simple-agent-manager

---

## Formatting Notes for LinkedIn

- No hashtags in the body. If adding, put 3-5 at the very end: #opensource #devtools #AIagents #cloudflare #BYOC
- The link will get deprioritized by LinkedIn's algorithm. Consider putting it in a comment instead and ending the post with a question like "Anyone else using AI agents for more than just code completion?"
- All variants are under 1,300 chars at the fold for the hook (first ~3 lines visible before "see more")
- No em dashes used (per style guide)
- First person throughout
- No marketing-speak ("unlock", "revolutionize", "game-changing")

## Personal Hook Suggestion

If Raph has a specific moment from this month that stood out (reading an agent's post-mortem, watching an agent chain, a specific bug that was funny or surprising), leading with that story would strengthen any variant. The "agents writing post-mortems about other agents' bugs" detail is interesting but needs a concrete example to land well.
