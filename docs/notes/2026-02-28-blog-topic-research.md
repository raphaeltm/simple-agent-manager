# Blog Topic Research

**Date**: 2026-02-28
**Purpose**: Identify blog topics from our codebase and recent work that could get traction in the broader developer community.

---

## Methodology

- Reviewed the last ~40 commits (TDF-1 through TDF-8, mobile chat UX, CI/CD hardening, wrangler binding fixes, post-mortem)
- Surveyed competitor content from Coder, Pulumi, Northflank, The New Stack, and Cloudflare's own blog
- Identified gaps: topics we have deep, hard-won experience with that are underrepresented in the current landscape

---

## Recommended Topics (Ranked)

### 1. "828 Tests Passed. The Feature Didn't Work." — A Post-Mortem on Component vs. Capability Testing

**Why this wins**: Post-mortems consistently outperform other technical content. This one is especially good because the failure mode is universal — every team that decomposes work into focused tasks risks the same "bridge to nowhere" integration gap.

**What we have**: A detailed post-mortem (`docs/notes/2026-02-28-missing-initial-prompt-postmortem.md`) documenting how 8 focused task PRs, 828 tests, and automated code review all passed while the core feature (task execution) was completely broken. The root cause: every component assumed the next component in the chain handled prompt delivery, and nobody owned the end-to-end path.

**Angle**: Frame it as a pattern, not just our bug. The lessons are:
- Component tests prove components work; only capability tests prove the *system* works
- Documentation-as-specification drift (aspirational claims treated as implementation facts)
- Incremental decomposition orphans cross-cutting concerns
- API naming lies (`createAgentSession()` vs `registerAgentSession()`)

**Competition**: Surprisingly thin. Most testing content is "write more tests" or "shift left." Very little covers the specific failure mode of *correct components that don't compose into a working system*. Google's 2025 DORA Report found 90% AI adoption increase correlates with 9% bug rate climb and 154% PR size increase — this post-mortem is a concrete case study of exactly that dynamic.

**Target audience**: Engineering managers, tech leads, senior engineers. Anyone who's merged a green CI pipeline and then discovered the feature doesn't work.

---

### 2. Warm Node Pooling: Three-Layer Defense Against Orphaned Infrastructure

**Why it's strong**: Infrastructure cost leaks are a universal pain point. Our implementation combines Durable Object state machines, alarm-based cleanup, cron sweeps, and max-lifetime caps into a pattern that's broadly applicable.

**What we have**: The NodeLifecycle DO implements a state machine (active -> warm -> destroying) where nodes enter a "warm" pool for 30 minutes after task completion for fast reuse. Three independent layers prevent orphans: DO alarm, cron sweep, max lifetime.

**Angle**: "Defense in depth for ephemeral infrastructure." Present the three-layer pattern as a reusable architecture for anyone managing short-lived cloud resources. Include the failure modes each layer catches that the others miss.

**Competition**: Coder blogs about workspace lifecycle but focuses on enterprise governance, not the infrastructure reclamation problem. AWS and GCP content covers spot instance management but not the warm-pool-with-orphan-defense pattern. Cloudflare's own blog covers Durable Objects but not this specific use case.

**Target audience**: Platform engineers, infrastructure teams, anyone running ephemeral compute.

---

### 3. Hybrid D1 + Durable Objects: When One Database Isn't Enough

**Why it's strong**: Cloudflare's ecosystem is booming, but real-world architecture content (beyond hello-world) is scarce. Our hybrid storage pattern — D1 for cross-project queries, per-project Durable Objects with embedded SQLite for write-heavy data — solves a real problem that anyone building on Cloudflare will hit.

**What we have**: ADR-004 documents the decision. In practice, D1 handles dashboard queries, task lists, and user lookups (read-heavy, cross-project). Per-project DOs handle chat sessions, messages, and activity events (write-heavy, single-project scope). This avoids D1's write contention while keeping cross-project queries efficient.

**Angle**: "Your Cloudflare Workers app needs two databases. Here's how to split them." Walk through the decision criteria, the data flow, and the gotchas (consistency between D1 and DO state, migration patterns).

**Competition**: Jamie Lord's "Rethinking State at the Edge" (Jan 2026) covers DO theory well but not the hybrid pattern. Cloudflare's reference architecture covers control/data plane sharding. Nobody has written the practical "here's how we split reads and writes across D1 and DOs" guide.

**Target audience**: Cloudflare Workers developers, serverless architects.

---

### 4. BYOC Without Touching Customer Credentials

**Why it's strong**: BYOC is a hot topic — Northflank, Confluent, and The New Stack all have recent posts framing it as the future of SaaS. But most content focuses on "run our code in your VPC." Our model is different: users provide their own Hetzner tokens, which are encrypted per-user in D1. The platform never has cloud provider credentials.

**What we have**: The BYOC credential model where user tokens are encrypted at rest per-user, never stored as environment variables or Worker secrets. The platform provisions infrastructure using the user's own credentials, but the credential material never leaves the encrypted D1 row except during an active API call.

**Angle**: "BYOC without a data plane in the customer's account." Most BYOC architectures deploy a control plane + data plane split. Ours is simpler: we call cloud APIs using the customer's encrypted credentials. Compare the tradeoffs (simplicity vs. control plane isolation, latency vs. security surface area).

**Competition**: Heavy on the enterprise BYOC side (Confluent, Redpanda, Aiven) but focused on data infrastructure. Nobody is writing about BYOC for dev tooling platforms or the "credential vault" approach vs. the "data plane" approach.

**Target audience**: SaaS founders, platform architects, security engineers.

---

### 5. The Wrangler Gotcha That Only Breaks in Production

**Why it's strong**: Short, punchy, high SEO potential. Wrangler's non-inheritable bindings are a genuine trap — bindings work locally and in tests but are `undefined` in staging/production. We lost time to this twice.

**What we have**: Documented in our rules (`07-env-and-urls.md`), plus commit history showing the fix (`f67c4bf`, `06e3f72`). The core issue: Wrangler does not inherit `durable_objects`, `d1_databases`, `kv_namespaces`, `r2_buckets`, `ai`, or `tail_consumers` from top-level config into `[env.*]` sections. Miniflare tests configure bindings independently, so they never catch this.

**Angle**: Quick-hit troubleshooting post. "If your Cloudflare Worker bindings work locally but are undefined in production, here's why." Include the fix (duplicate bindings into every env section) and the validation approach.

**Competition**: Cloudflare docs mention non-inheritance but don't emphasize the danger. No prominent blog post covers this specific pitfall with a real-world debugging story.

**Target audience**: Cloudflare Workers developers (high search intent topic).

---

## Topics Considered but Deprioritized

| Topic | Why Deprioritized |
|-------|-------------------|
| Go VM Agent (PTY/WebSocket/ACP) | Interesting but niche; the target audience for PTY multiplexing in Go is small |
| Cloud-init VM bootstrapping | Well-covered territory (Terraform, Packer, etc. all have this) |
| Dual auth (API keys + OAuth) | Good content but less differentiated; many apps support multiple auth modes |
| Task runner autonomous execution | Hard to write about without the post-mortem context; combine with topic #1 if writing a series |
| Mobile chat UX on Workers | Interesting but too product-specific for broad appeal |

---

## Publication Strategy

**Recommended order**:
1. Start with **#1 (post-mortem)** — it has the widest appeal and the strongest narrative. Post-mortems get shared. This is the kind of content that gets picked up on Hacker News and dev Twitter.
2. Follow with **#5 (Wrangler gotcha)** — quick to write, high SEO value, establishes credibility in the Cloudflare ecosystem.
3. Then **#3 (hybrid D1 + DO)** — deeper technical content for the Cloudflare audience we've now attracted.
4. **#2 (warm node pooling)** and **#4 (BYOC)** can follow as the audience grows.

**Where to publish**: Dev.to or personal blog for initial posts (easy to publish, good SEO). Cross-post to Hashnode. Consider submitting the post-mortem to Hacker News "Show HN" or as a standalone post.

---

## Sources Consulted

- [Coder: Infrastructure for Autonomous Coding](https://coder.com/blog/coder-is-open-to-build-the-infrastructure-for-autonomous-coding)
- [Coder: Enterprise-Grade Platform for Self-Hosted AI Dev Environments](https://coder.com/blog/coder-enterprise-grade-platform-for-self-hosted-ai-development)
- [Pulumi: AI Predictions for 2026 — A DevOps Guide](https://www.pulumi.com/blog/ai-predictions-2026-devops-guide/)
- [The New Stack: SaaS Is Broken — BYOC Is the Future](https://thenewstack.io/saas-is-broken-why-bring-your-own-cloud-byoc-is-the-future/)
- [Northflank: BYOC — Future of Enterprise SaaS](https://northflank.com/blog/bring-your-own-cloud-byoc-future-of-enterprise-saas-deployment)
- [Jamie Lord: Rethinking State at the Edge with Durable Objects](https://lord.technology/2026/01/12/rethinking-state-at-the-edge-with-cloudflare-durable-objects.html)
- [Cloudflare: Control and Data Plane Pattern for DOs](https://developers.cloudflare.com/reference-architecture/diagrams/storage/durable-object-control-data-plane-pattern/)
- [Mike Mason: AI Coding Agents — Coherence Through Orchestration](https://mikemason.ca/writing/ai-coding-agents-jan-2026/)
- [Jack Vanlightly: On the Future of Cloud Services and BYOC](https://jack-vanlightly.com/blog/2023/9/25/on-the-future-of-cloud-services-and-byoc)
