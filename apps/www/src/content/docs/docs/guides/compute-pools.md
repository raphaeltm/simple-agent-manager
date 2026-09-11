---
title: Compute Pools
description: How SAM decides which cloud machine to run your work on — pools, scopes, strategies, exhaustion policies, and resource requirements.
---

A **compute pool** is the set of cloud machines SAM is allowed to rent on your behalf. When you
start work, SAM looks at how much machine that work asks for, looks at the pool that governs it,
and either reuses a machine you already have or provisions one of the specific instance types the
pool permits.

You may also see pools called **node pools** or **capacity pools** — same thing. The app labels
them "Infrastructure Compute Pool".

:::note
Most people never open this page in the product. If you have connected a cloud provider (or you
are on the hosted platform, where compute is provided for you), SAM sets up a sensible pool the
first time it needs one and keeps it in sync. Read on when you want to control _which_ machines
get rented, _how big_ they are, or _what happens when your provider is out of capacity_.
:::

## The 30-second version

| Question                                         | Where it is answered                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| Which machines may SAM rent?                     | The **allowed offerings** in your compute pool                             |
| Whose cloud account pays?                        | The **sources** (credentials) attached to that pool                        |
| How much machine does this work need?            | **Resource requirements** — set per task, skill, agent profile, or project |
| Which machine gets picked from the allowed ones? | The pool's **strategy**                                                    |
| What happens when nothing is available?          | The pool's **exhaustion policy**                                           |

## Where to find pools in the app

Pools exist at three **scopes**, each edited in a different place:

| Scope               | Where to edit it                                                                                     |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| **Project**         | Project → Settings → Infrastructure. Owners and admins can edit; maintainers can view and reconcile. |
| **User** (personal) | Settings → Infrastructure. Yours alone.                                                              |
| **Installation**    | Admin → Infrastructure. Platform superadmins only.                                                   |

Each panel shows the pool that is currently in effect for that context, the credentials feeding
it, and the list of provider instance types it permits.

You can also see the pool in effect without leaving your work: the **workspace sidebar** and a
chat session's **infrastructure** section both show a "Current compute pool" line with the scope,
state, strategy, and how many offerings are available.

### The other settings on the same page

A project's **Infrastructure** tab holds three things, and it is worth knowing which is which:

| Section                         | What it controls                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| **Default Resources**           | How much machine work asks for, when nothing more specific says otherwise                      |
| **Scaling & Scheduling**        | The default provider and region, plus how densely nodes are packed and how long they stay warm |
| **Infrastructure Compute Pool** | Which concrete machines SAM may rent, and how it chooses between them                          |

The first two feed the pool decisions described below, so they are covered here too.

### Default provider and region

**Scaling & Scheduling → Provider & Location** sets a project's default provider and region. They
are not part of the pool, but they narrow what the pool may choose from:

- The **provider** is a hard filter. Once a provider is resolved — from an explicit request, then
  the agent profile, then the project default — offerings from every other provider are dropped,
  even if the pool allows them. If your pool spans two clouds and everything lands on one of them,
  this setting is usually why.
- The **region** is only a preference. A project default region influences which offering is picked
  but does not exclude the others; only a region requested explicitly for that piece of work pins
  placement to it.

Leave both blank and SAM uses whatever the pool and the resolved credentials allow.

## Scopes and precedence

SAM considers exactly **one** pool per run. It walks the scopes in order and takes the first one
that has a pool at all:

```
project  →  user  →  installation
```

- A project with its own pool uses that pool. Its nodes are dedicated to that project.
- No project pool? Your personal pool applies, and your nodes can host your work across the
  projects you have access to.
- Neither? The installation pool applies. On the hosted platform this is the "installation-funded"
  compute that lets you work without connecting a cloud account of your own.

:::caution
**There is no fallback _between_ pools.** Precedence is decided by whether a pool _exists_, not by
whether it is healthy. If a project has a pool and that pool is empty, disabled, or its provider
catalog is unavailable, SAM does **not** quietly fall back to your personal or the installation
pool — it queues or fails inside the project pool according to that pool's exhaustion policy.

This is deliberate: a project pool usually exists because someone decided that project's compute
must be billed to a specific account. Silently borrowing another account's capacity would break
that decision. If you want a project to use your personal pool, remove the project pool rather
than emptying it.
:::

The **Reconcile** button creates the pool for the scope you are viewing (from the credentials
available to that scope) and refreshes it from the provider's live catalog. If you see a banner
saying you are using a lower-scope fallback, reconciling the current scope is how you create an
editable pool that takes precedence.

## What is inside a pool

### Sources

A **source** is one cloud provider credential the pool is allowed to spend against. Sources come
from credentials you have already connected:

- **Project** credentials — a cloud credential a member has connected and granted to the project.
  It works like a project-scoped API key: the credential stays user-managed, but the project may
  use it for infrastructure.
- **User** credentials — your personal cloud provider connection, from **Settings → Cloud
  Provider**.
- **Platform** credentials — installation-level credentials added by a superadmin.

A pool with no active source cannot rent anything. The panel links straight to the right setup
page when that is the case.

### Allowed offerings

An **offering** is one concrete, provider-native machine: a specific instance type in a specific
region, with real vCPU, RAM, disk, and price. Not `small`/`medium`/`large` — the actual
`cpx31`-style SKU your provider sells.

When SAM reconciles a pool it discovers your provider's **full** catalog for each source and lists
every offering in the editor. Each row is one of:

| State                  | Meaning                                                                   |
| ---------------------- | ------------------------------------------------------------------------- |
| **Allowed**            | SAM may provision this instance type                                      |
| **Not selected**       | In the pool, but switched off — SAM will not use it                       |
| **Removed**            | Explicitly removed from the pool                                          |
| **Catalog only**       | Your provider sells it, but it has never been added to this pool          |
| **Unavailable**        | Your provider is not currently offering it (region sold out, SKU retired) |
| **Stale catalog data** | The last catalog refresh could not confirm it                             |

Only **Allowed** offerings are eligible for placement. The editor separates the offerings your
pool allows from the ones it excludes and from the rest of the provider's catalog, so you can
browse everything your provider sells and add a machine type without leaving the page.

You can filter by provider, location, minimum vCPU, minimum RAM, maximum monthly price, and
availability, then toggle individual offerings on or off.

#### How reconcile treats your choices

Reconcile refreshes catalog facts — prices, specs, availability, new SKUs — without undoing your
decisions:

- An offering you explicitly enabled or removed keeps the status you gave it.
- A brand-new offering that appears in the catalog is added in the **Not selected** state, so
  your provider adding a machine type never silently changes what SAM rents.
- On first creation, SAM enables the offerings that correspond to the machine sizes it has always
  supported, so a fresh pool works immediately.
- A provider API failure during refresh is reported as a refresh error; SAM does not invent
  availability it could not confirm.
- **Starting work never refreshes the catalog.** Placement reads the pool as it stands, so a
  submission is never delayed by a provider API call and a deliberately emptied pool is never
  quietly repopulated. Refreshing is something you do — via **Reconcile** — not a side effect of
  running a task. (The one exception is an installation upgraded from the old size presets, whose
  pool is materialized into native offerings once.)

:::note
Allowing an offering allows it for **both** workspace machines and
[app deployment](/docs/guides/app-deployments/) machines. You curate one row per instance type;
SAM keeps the two workload roles in sync behind it.
:::

## Strategy: which machine gets picked

**Strategy** decides the order SAM considers machines in — both existing nodes it could reuse and
fresh offerings it could provision. New pools default to **Balanced**.

| Strategy                 | What it does                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Balanced** _(default)_ | **Lowest projected utilization first.** Spreads work over the machines you already pay for, leaving headroom on each.                            |
| **Pack**                 | **Highest projected utilization that still fits, first.** Fills one host before opening another, keeping the machine count — and the bill — low. |
| **Spread**               | **Fewest neighbouring workspaces first.** Buys isolation and predictable performance at the cost of running more machines.                       |
| **Smallest fit**         | **Smallest sufficient capacity first.** Puts small work on cheap machines and keeps the big ones free for work that needs them.                  |

A few things worth knowing:

- Strategy only **orders** machines that are already known to fit. It can never let work onto a
  host that fails the capacity checks below — changing strategy cannot overcommit a node.
- **Pack** and **Spread** are about _distribution_, so for a brand-new machine they are applied to
  the provider/region you already have machines in: Pack concentrates there, Spread moves away.
- "Projected utilization" means how full a host would be _after_ placing this work, measured on
  its fullest dimension (CPU, memory, or disk).

The session's infrastructure panel spells the applied ordering out in plain language — for
example, _"Why this node: lowest projected utilization first"_.

## Exhaustion policy: what happens when nothing is available

Providers run out of capacity, regions sell out, and accounts hit server limits. **Exhaustion
policy** is what SAM does when no permitted machine can be obtained. New pools default to
**Queue**.

| Policy                | Behaviour                                                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Queue** _(default)_ | Park the work and keep retrying until capacity returns, up to a maximum visible wait (2 hours by default). Good when the work can wait and you would rather not fail. |
| **Fail**              | Stop with a capacity error instead of waiting. Good when you would rather know at once than discover a task waited an hour. One exception, below.                     |
| **Fallback chain**    | Try the pool's other allowed offerings, in ranked order, before giving up. Good when you have several acceptable machine types and just want _something_ that fits.   |

:::note
Fallback chain only tries alternatives **from the same pool, on the same credential, in the same
region if you pinned one, and only offerings that still satisfy the work's requirements**. It
never downgrades to a machine smaller than the work asked for, never borrows another account's
capacity, and never crosses into a different pool. If every permitted alternative is exhausted,
the failure names what was tried.
:::

:::caution
**One capacity failure ignores the policy.** These three policies govern _per-offering_ scarcity —
a particular instance type being sold out in a particular region. When the provider instead reports
that your whole **account** is out of capacity (a Hetzner server-limit error, for example), SAM
always parks the work and retries after a provider cooldown, even under **Fail**, and gives up only
when the overall capacity wait expires.

That is deliberate: trying other instance types against an account that has hit its own limit
cannot succeed, and just multiplies failed provider calls. But it does mean **Fail** is not a
guarantee of an immediate error in every capacity situation. If you are hitting this, the fix is
your provider account's server limit, not the pool.
:::

While work is waiting for capacity, the chat's infrastructure section shows "Waiting for capacity"
and the next retry time, so a queued task is visible rather than silently stuck.

## Resource requirements: how much machine work asks for

A pool says what SAM _may_ rent. Resource requirements say what a particular piece of work
_needs_. SAM resolves them, then keeps only the offerings and nodes that satisfy them.

### The fields

| Field              | Meaning                                                                                          | Platform default |
| ------------------ | ------------------------------------------------------------------------------------------------ | ---------------- |
| **vCPU**           | Minimum vCPU                                                                                     | 2                |
| **Memory (GB)**    | Minimum RAM                                                                                      | 4                |
| **Disk (GB)**      | Minimum disk                                                                                     | 40               |
| **Exclusive node** | The work must have the machine to itself                                                         | Off              |
| `maxCoTenants`     | Maximum workspaces allowed to share the machine. Not in the form — set it through the API or MCP | 4                |

Every field is optional. Leave a field blank and it **inherits** — it is resolved from the next
level down, field by field. Setting vCPU without setting memory is fine and normal.

### Where you can set them

Requirements resolve in this order, highest priority first:

```
task  →  trigger  →  skill  →  agent profile  →  project  →  platform default
```

- **Task** — the **Resources** control next to the chat composer, or the task submit form.
  Use it for a one-off heavy job.
- **Trigger** — the trigger form. Use it when scheduled or webhook work needs a different
  machine from interactive chat.
- **Skill** — the skill editor. Use it for a kind of work that always needs more, or less.
- **Agent profile** — the profile editor. This is the normal size for work run with that profile.
- **Project** — Project → Settings → Infrastructure → **Default Resources**. The baseline for
  everything in the project.
- **Platform** — set by the deployment (`CAPACITY_POOL_PLATFORM_DEFAULTS_JSON`, or the persisted
  platform setting; see the [Configuration Reference](/docs/reference/configuration/)). The
  installation-wide floor.

Each level fills in only the fields the levels above it left blank, so a project can set the disk
floor while a profile sets CPU and memory. SAM records where each field came from, which is what
lets the chat show the original request alongside the machine that was chosen.

:::note
Older projects may still carry a legacy `small` / `medium` / `large` default. It still works —
SAM translates it into concrete requirements — but it is shown as _Legacy_ in the resource editor
with a link to clear it. Prefer explicit vCPU/memory/disk values: a legacy size is a label, not a
statement about how much hardware the workload needs.
:::

## How a machine actually gets chosen

Putting it together, when you start work SAM:

1. **Resolves the requirements** by walking the precedence chain above.
2. **Resolves the pool** by walking project → user → installation.
3. **Looks for a machine you already have.** A node can be reused only if it belongs to you, is
   in the same pool at the same revision, was provisioned from the same credential and the same
   instance type, and — for a project pool — belongs to that project. Anything else means the node
   is not interchangeable with what the current request resolved to.
4. **Checks that the machine can actually take the work** (see below). Candidates are ordered by
   the pool's strategy; the capacity check is re-run atomically when the workspace slot is
   claimed, so two simultaneous requests can never both take the last slot.
5. **Otherwise provisions a new machine** from the allowed offerings that satisfy the
   requirements, ranked by strategy, price, and fit.
6. **Applies the exhaustion policy** if nothing works.

### When a machine can be shared

Sharing a node ("co-tenancy") is what makes follow-up work start in seconds instead of minutes.
A node accepts additional work only if **all** of these hold:

- The sum of every active workspace's reserved CPU, memory, and disk — plus this request — still
  fits the machine's real hardware. By default only memory holds headroom back for the host
  itself (512 MB); CPU may be committed up to 100% of the machine, and disk is compared
  against the whole disk, unless the deployment configures otherwise.
- The workspace count is under **Max Workspaces Per Node** (3 by default) and under the co-tenant
  cap requested by this work _and_ by everything already on the node.
- Nothing on the node asked for an exclusive machine, and this work is not asking for one.
- A node that is **already hosting work** is reporting fresh health telemetry, and its memory and
  disk pressure are below their thresholds (50% memory, 90% disk by default). A brand-new machine
  that has not reported yet is not held back by this.
- Live CPU is treated differently from memory and disk. CPU is shared out by the kernel, so a busy
  machine runs work more slowly rather than breaking, and each workspace's CPU is already reserved
  from the machine's budget above. Measured CPU therefore only blocks placement once the machine is
  **saturated** (90% by default); below that, the reservations decide.

If a node's real hardware is unknown, or a busy node's telemetry is missing, malformed, or stale,
SAM refuses it rather than guessing. A machine SAM cannot measure is never given work.

**Max Workspaces Per Node**, **Node CPU Threshold**, and **Node Memory Threshold** are per-project
overrides in **Scaling & Scheduling → Node Scheduling**; leave a field blank to use the platform
default shown as its placeholder. Raise them to pack machines harder and spend less, lower them for
more headroom per workspace. The disk-pressure threshold has no per-project control and is set by
the deployment.

### Warm reuse

When the last workspace leaves a machine SAM provisioned automatically, the machine stays **warm**
for 30 minutes by default. Follow-up work in that window reuses it, turning a two-minute
provisioning wait into a few seconds. After that, idle machines are cleaned up automatically, so
you are not paying for capacity you stopped using.

**Warm Node Timeout** is a per-project override in **Scaling & Scheduling → Node Scheduling**. A
longer window makes bursts of follow-up work start faster, at the cost of holding a machine you are
not currently using; a shorter one releases capacity sooner.

:::note
This is not the same as **Workspace Idle Timeout**, which sits on the same settings tab. Warm
timeout is about a _machine_ that has no workspaces left on it. Workspace idle timeout is about an
individual _workspace_ that has gone quiet.
:::

## Pool states and what to do about them

The panel shows a state for the pool in effect. What each one means:

| State                                     | What it means, and what to do                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Available**                             | Ready — active sources and at least one available allowed offering. Nothing to do.                                   |
| **Not configured**                        | No pool exists at any scope. Connect a cloud credential, then **Reconcile**.                                         |
| **Empty — no eligible offerings**         | The pool has no active source, or no offering is enabled. **Edit** it and allow an offering, or attach a credential. |
| **Unavailable — compute source disabled** | The credential behind the pool was disabled, revoked, or deleted. Reconnect or re-enable it, then **Reconcile**.     |
| **Unavailable — catalog refresh needed**  | Every allowed offering is currently unavailable at the provider. **Reconcile**, then allow one that is still sold.   |
| **Migration in progress**                 | SAM is still upgrading this pool's stored configuration. Wait, then reload.                                          |

Remember that a project pool in any of the unhealthy states stays authoritative — fix it, or
remove it so a lower scope applies.

## Troubleshooting

| Symptom                                                        | Likely cause                                                                                                                                                                                  |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Waiting for capacity" that never clears                       | The pool's allowed offerings are sold out in the chosen region. Allow more offerings or regions, or switch the policy to **Fallback chain**.                                                  |
| Work fails immediately with a capacity error                   | Exhaustion policy is **Fail**, or the pool has no allowed offering that satisfies the requirements.                                                                                           |
| No offering satisfies the request                              | Requirements exceed every allowed machine — remember the host memory reserve, so a 4 GiB offering tops out at a 3584 MiB reservation. Lower the requirements or allow a bigger instance type. |
| A new machine is provisioned for every task                    | Requirements ask for an exclusive node, `maxCoTenants` is 1, or each request is large enough to fill a machine.                                                                               |
| Machines are bigger or pricier than expected                   | Check the resolved requirements in the chat's infrastructure panel — a profile, skill, or project default may be raising the floor.                                                           |
| Editing is disabled                                            | Project pools need owner or admin (`secret:write`); maintainers can view and reconcile but not edit.                                                                                          |
| The project ignores your personal pool                         | The project has its own pool. Remove it if you want the personal pool to apply.                                                                                                               |
| Everything lands on one cloud although the pool allows several | A default provider is set on the project or the agent profile, and it filters the others out.                                                                                                 |
| Too many, or too few, workspaces share a machine               | Adjust **Max Workspaces Per Node** and the CPU/memory thresholds in Scaling & Scheduling, or set a co-tenant cap on the work itself.                                                          |
| Work waits for capacity even though the policy is **Fail**     | The provider reported account-wide exhaustion, which always retries. Check your provider account's server limit.                                                                              |

## Where to look when you want the details

- The **workspace sidebar** and the chat session **infrastructure** section show the pool in
  effect, its strategy, its exhaustion policy, and how many offerings are available.
- A task's **saved placement decision** records what was requested, which pool decided it, the
  ordering that was applied, and why the selected node won.
- The **Nodes** page shows each machine's **Observed hardware** (what the machine reports about
  itself) next to its **Configured offering** (what the pool asked the provider for).

## Related

- [Workspaces](/docs/guides/creating-workspaces/) — providers, regions, and the workspace lifecycle
- [Instant Sessions](/docs/guides/instant-sessions/) — the container runtime, which does not use pools
- [Core Concepts](/docs/concepts/) — nodes, providers, projects, profiles, and skills
- [Configuration Reference](/docs/reference/configuration/) — self-hosting environment variables for
  pool selection weights, admission control, warm timeouts, and node reaping
- [API Reference](/docs/reference/api/#capacity-pools) — the capacity-pool endpoints
