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

| Section                         | What it controls                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Default Resources**           | How much machine work asks for, when nothing more specific says otherwise                                  |
| **Scaling & Scheduling**        | The default provider and region, plus how densely nodes are packed and how long they stay warm             |
| **Infrastructure Compute Pool** | Which concrete machines SAM may rent, and how it chooses between them — for workspaces and for deployments |

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

**Waking a sleeping session** keeps the resources the session originally resolved, not its machine
type or region. The region it slept in is a preference: a running machine there is reused first,
but a machine with room in any other region the pool allows is reused before a new one is started,
and the whole pool stays available if one has to be. A snapshot restores in any region. Only a
conversation whose first run explicitly requested a region (through the API or an agent's
`dispatch_task`) is woken back into that region. A workspace moved off its machine by eviction is
placed like new work, with no preference for its old region.

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
fresh offerings it could provision.

| Strategy                           | What it does                                                                                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Balanced** _(workspace default)_ | **Lowest projected utilization first.** Spreads work over the machines you already pay for, leaving headroom on each.                                             |
| **Pack**                           | **Highest projected utilization that still fits, first.** Fills an existing host before opening another; when provisioning, chooses the largest allowed offering. |
| **Spread**                         | **Fewest neighbouring workspaces first.** Buys isolation and predictable performance at the cost of running more machines.                                        |
| **Smallest fit**                   | **Smallest sufficient capacity first.** Chooses the smallest, then cheapest, sufficient offering and keeps bigger machines free for work that needs them.         |

A few things worth knowing:

- Strategy only **orders** machines that are already known to fit. It can never let work onto a
  host that fails the capacity checks below — changing strategy cannot overcommit a node.
- **Pack** and **Spread** are about _distribution_, so for a brand-new machine they are applied to
  the provider/region you already have machines in: Pack concentrates there, Spread moves away.
- "Projected utilization" means how full a host would be _after_ placing this work, measured on
  its fullest dimension (CPU, memory, or disk).

The session's infrastructure panel spells the applied ordering out in plain language — for
example, _"Why this node: lowest projected utilization first"_.

### The four policy fields

Agent workspaces and [app deployments](/docs/guides/app-deployments/) want opposite things — a
workspace is bursty and short-lived, a deployment is steady and long-lived — so the pool carries a
separate strategy for each. **Infrastructure Compute Pool → Edit** on whichever scope you own shows
all four settings together:

| Field                      | What it decides                                                  | Default      |
| -------------------------- | ---------------------------------------------------------------- | ------------ |
| **Workspace strategy**     | Machine ordering for agent sessions and tasks                    | Balanced     |
| **Deployment strategy**    | Machine ordering for app deployment nodes                        | Smallest fit |
| **Exhaustion policy**      | What happens when no permitted machine can be obtained           | Queue        |
| **Maximum nodes per user** | How many managed workspace nodes one user may run from this pool | 3            |

The credentials, the allowed offerings, and the providers and regions are shared between the two
workloads. You curate one list of machines; only the _ordering_ differs by workload. The
**exhaustion policy** is workspace-only — deployment placement does not consult it, so setting
**Queue** will not make a capacity-starved deployment park and retry.

### Maximum nodes per user

This is two things at once, and the second one surprises people:

- **For Spread, it is the switch-over point.** Spread opens a new machine per workspace until a
  user's node count in the pool reaches the limit, then starts packing onto the machines already
  running. The other strategies do not use it this way.
- **For every strategy, it is a hard ceiling.** Once a user is at the limit, SAM will not provision
  another node in that pool for them under any strategy. It reuses a machine that fits; if none
  fits, the work **queues until the overall capacity wait expires — even under Fail** — and then
  fails with _"Capacity pool node limit (N) reached and no node can fit the request."_ Set the
  limit to 2 under Balanced and you will hit that wait, not silently get a third node.

It counts **managed workspace nodes only** — nodes you brought yourself and deployment nodes are
not counted and are not capped by it. A separate installation-wide ceiling (`MAX_NODES_PER_USER`,
10 by default) applies on top, so raising the pool limit past that has no effect.

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
**Two capacity failures ignore the policy.** These three policies govern _per-offering_ scarcity —
a particular instance type being sold out in a particular region. Two other cases always park the
work and retry until the overall capacity wait expires, even under **Fail**:

- **Your whole account is out of capacity** (a Hetzner server-limit error, for example). Trying
  other instance types against an account that has hit its own limit cannot succeed, and just
  multiplies failed provider calls. The fix is your provider account's server limit, not the pool.
  A **vCPU core limit** (Hetzner's "shared core limit exceeded") is different, because a smaller
  machine may still fit under it. Under **Fallback chain**, SAM skips every remaining offering
  that needs at least as many cores of the same kind and carries on down the chain with the ones
  that need fewer; the work waits only when none of those fits. Under **Fail** or **Queue** there is
  no chain to descend, so it waits straight away. Shared and dedicated vCPUs have separate limits
  on Hetzner, so reaching one does not rule out the other.
- **The pool's [Maximum nodes per user](#maximum-nodes-per-user) is reached** and no running node
  can take the work. The fix is the limit, the requirements, or freeing a node.

So **Fail** is not a guarantee of an immediate error in every capacity situation.
:::

While work is waiting for capacity, the chat's infrastructure section shows "Waiting for capacity"
and the next retry time, so a queued task is visible rather than silently stuck.

## Resource requirements: how much machine work asks for

A pool says what SAM _may_ rent. Resource requirements say what a particular piece of work
_needs_. SAM resolves them, then keeps only the offerings and nodes that satisfy them.

### The fields

| Field              | Meaning                                                                                                   | Platform default |
| ------------------ | --------------------------------------------------------------------------------------------------------- | ---------------- |
| **vCPU**           | Minimum vCPU                                                                                              | 2                |
| **Memory (GB)**    | Minimum RAM                                                                                               | 4                |
| **Disk (GB)**      | Minimum disk                                                                                              | 40               |
| **Exclusive node** | The work must have the machine to itself                                                                  | Off              |
| `maxCoTenants`     | Deprecated compatibility metadata. Accepted for old clients and audit records, but does not cap placement | 4                |

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
SAM translates it into compatibility workload requirements — but it is shown as _Legacy_ in the
resource editor with a link to clear it. Prefer explicit vCPU/memory/disk values: a legacy size is
a label, not a statement about provider hardware. With the current compatibility adapter, `small`
means a roughly third-node workload slice (625 mCPU, 1152 MiB memory, 13 GiB disk, up to 3
co-tenants), while `medium` and `large` are two-per-node slices sized to stay off the class below
them after the default 512 MiB host memory reserve.
:::

## How a machine actually gets chosen

Putting it together, when you start work SAM:

1. **Resolves the requirements** by walking the precedence chain above.
2. **Resolves the pool** by walking project → user → installation.
3. **Looks for a machine you already have.** A node can be reused only if it belongs to you, keeps
   the current pool and credential authority, and — for a project pool — belongs to that project.
   Deployment placement may reuse a larger compatible node from any currently allowed pool
   offering when the declared reservation fits; workspace placement retains its existing
   compatibility rules.
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
- Nothing on the node asked for an exclusive machine, and this work is not asking for one.
- A node that is **already hosting work** is reporting fresh health telemetry, and its disk
  pressure is below its threshold (90% by default). Live memory percentage is used for ranking;
  explicit reserved memory and the host reserve control admission. A brand-new machine that has
  not reported yet is not held back by this.
- Live CPU is treated differently from memory and disk. CPU is shared out by the kernel, so a busy
  machine runs work more slowly rather than breaking, and each workspace's CPU is already reserved
  from the machine's budget above. Measured CPU therefore only blocks placement once the machine is
  **saturated** (85% by default); below that, the reservations decide. SAM also gives its own agent
  a larger share of the CPU than the workspace containers get, so a busy machine slows the work down
  without making the machine look unreachable.

If a node's real hardware is unknown, or a busy node's telemetry is missing, malformed, or stale,
SAM refuses it rather than guessing. A machine SAM cannot measure is never given work.

**Node CPU Threshold** is a per-project overload-backpressure override in **Scaling & Scheduling →
Node Scheduling**. Legacy workspace-count and memory-threshold values remain readable for
compatibility, but do not gate placement. The disk-pressure threshold is deployment-controlled.

Managed workspace nodes are user-isolated, so **Spread** opens a separate node per workspace for
that user until their node count in the pool reaches [**Maximum nodes per
user**](#maximum-nodes-per-user), then packs further sessions onto those nodes. **Pack** takes the
largest allowed offering and fills it densely; **Smallest fit** takes the smallest, then cheapest,
sufficient offering.

### How deployment placement differs

For a deployment **without** persistent volumes, SAM always looks for a healthy, compatible
deployment node whose declared CPU, memory, and disk reservations still leave room before it
provisions anything — whatever the strategy. Reuse is also capped by how many environments one
deployment node may host (`MAX_ENVIRONMENTS_PER_DEPLOYMENT_NODE`, 5 by default), which is a second
reason a new machine can appear while an existing one still looks roomy. The pool's
[**Deployment strategy**](#the-four-policy-fields) only orders the _provisioning_ step; under its
**Smallest fit** default that means the smallest allowed machine that can hold the deployment.

A deployment **with** persistent volumes skips that search entirely and always gets its own
machine — see below.

What drives the size is your **deployment manifest**:

- **CPU and memory** come from each service's `deploy.resources.limits`, summed across services.
  Machine sizing ignores `deploy.resources.reservations` — it is neither read for sizing nor
  rejected, so a manifest that sets only reservations silently gets the per-service defaults
  (`DEPLOYMENT_DEFAULT_CPU_LIMIT_MILLIS` and `DEPLOYMENT_DEFAULT_MEMORY_LIMIT_MB`). The block is
  still passed through to Docker, where it constrains the running container — it just does not
  decide which machine you land on.
- **Disk** does not come from `limits` at all. Each service reserves 1 GB of root disk by default
  (`DEPLOYMENT_DEFAULT_ROOT_DISK_MB`), plus each named volume's `x-sam-size-hint-mb`.
- **Environment names carry no weight.** Calling an environment `production` does not buy it a
  bigger machine than one called `preview`.

If a deployment machine is larger than you expected, read the manifest first. See
[App Deployments](/docs/guides/app-deployments/).

If no node can take the deployment and none can be provisioned, the release is marked **failed
immediately** — deployment placement does not queue and does not retry, so setting the pool's
exhaustion policy to **Queue** changes nothing here. Free capacity or lower the manifest's limits,
then submit a new release.

Deployments with persistent volumes still get an exclusive node — a volume is attached to one
machine, so the environment cannot be relocated or share a host.

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

| Symptom                                                                | Likely cause                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Waiting for capacity" that never clears                               | The pool's allowed offerings are sold out in the chosen region. Allow more offerings or regions, or switch the policy to **Fallback chain**.                                                                                                                                  |
| Work fails immediately with a capacity error                           | Exhaustion policy is **Fail**, or the pool has no allowed offering that satisfies the requirements.                                                                                                                                                                           |
| "Capacity pool node limit (N) reached and no node can fit the request" | The user is at **Maximum nodes per user** for this pool and no running node has room. Raise the limit, lower the requirements so an existing node fits, or free a node.                                                                                                       |
| No offering satisfies the request                                      | Requirements exceed every allowed machine — remember the host memory reserve, so a 4 GiB offering tops out at a 3584 MiB reservation. Lower the requirements or allow a bigger instance type.                                                                                 |
| A new machine is provisioned for every task                            | Requirements ask for an exclusive node, each request fills a machine, or **Spread** has not reached the pool's maximum-node limit.                                                                                                                                            |
| Workspace machines are bigger or pricier than expected                 | Check the resolved requirements in the chat's infrastructure panel — a profile, skill, or project default may be raising the floor. Then open **Resources** on a finished session to see what it actually used ([Session Resource History](/docs/guides/session-resources/)). |
| A deployment machine is bigger than expected                           | Check the service CPU and memory limits in its deployment manifest, the pool's deployment strategy, and which smaller offerings the pool allows.                                                                                                                              |
| Editing is disabled                                                    | Project pools need owner or admin (`secret:write`); maintainers can view and reconcile but not edit.                                                                                                                                                                          |
| The project ignores your personal pool                                 | The project has its own pool. Remove it if you want the personal pool to apply.                                                                                                                                                                                               |
| Everything lands on one cloud although the pool allows several         | A default provider is set on the project or the agent profile, and it filters the others out.                                                                                                                                                                                 |
| Too many, or too few, workspaces share a machine                       | Adjust explicit CPU, memory, and disk requirements, use **Exclusive node** for isolation, or change the pool strategy and maximum-node limit. [Session Resource History](/docs/guides/session-resources/) is the evidence for what the requirements should be.                |
| Work waits for capacity even though the policy is **Fail**             | The provider reported an account limit (server or vCPU core limit, the latter after trying smaller offerings under Fallback chain), or the pool's [Maximum nodes per user](#maximum-nodes-per-user) is reached. Both always wait.                                             |

## Where to look when you want the details

- The **workspace sidebar** and the chat session **infrastructure** section show the pool in
  effect, its strategy, its exhaustion policy, and how many offerings are available.
- A task's **saved placement decision** records what was requested, which pool decided it, the
  ordering that was applied, and why the selected node won.
- The **Nodes** page shows each machine's **Observed hardware** (what the machine reports about
  itself) next to its **Configured offering** (what the pool asked the provider for).
- A finished session's **Resources** panel shows what that work actually consumed, which is the
  only evidence that tells you whether a requirement is too high or too low — see
  [Session Resource History](/docs/guides/session-resources/).

## Related

- [Workspaces](/docs/guides/creating-workspaces/) — providers, regions, and the workspace lifecycle
- [Session Resource History](/docs/guides/session-resources/) — what a session actually used, and
  how to turn that into the right resource requirement
- [Instant Sessions](/docs/guides/instant-sessions/) — the container runtime, which does not use pools
- [Core Concepts](/docs/concepts/) — nodes, providers, projects, profiles, and skills
- [Configuration Reference](/docs/reference/configuration/) — self-hosting environment variables for
  pool selection weights, admission control, warm timeouts, and node reaping
- [API Reference](/docs/reference/api/#capacity-pools) — the capacity-pool endpoints
