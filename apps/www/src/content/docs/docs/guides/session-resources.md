---
title: Session Resource History
description: Read the CPU, memory, and I/O history SAM retains for a workspace so you can explain a crash, a slowdown, or an oversized machine.
---

Every VM-backed workspace records what it actually used — CPU, memory, disk I/O, and
out-of-memory events — and keeps that history after the machine is gone. Open **Resources**
in a chat session's tool rail to read it. ([Instant](/docs/guides/instant-sessions/) sessions
are the exception — see [below](#where-resource-history-exists--and-where-it-doesnt).)

This answers questions you previously had to guess at:

- _The agent died mid-task. Did it run out of memory?_
- _This session took 40 minutes. Was it working, or waiting?_
- _Am I paying for a 16 GB machine to run something that peaks at 900 MB?_

## Where to find it

In a project chat, open the [session tool rail](/docs/guides/chat-features/#the-session-tool-rail)
on the right edge and click **Resources** (the activity icon). The panel opens as a side drawer on
desktop and full-screen on mobile.

The button is always there, including on sessions that already ended — which is usually when you
want it, because the workspace is gone and this is the only record left. It is also there on
sessions that never collected anything, where it shows an empty state rather than hiding itself.

![The Resources drawer for a chat session: stat cards reading CPU peak 4120 ms/sample, RAM peak 3.4 GB, I/O total 384 MB read and 1.1 GB write, and 360 samples with 1 gap; an amber banner reading "1 OOM event observed in retained samples"; a detail timeline chart with a green CPU line, a dashed purple RAM line, blue tool-window bands and an amber OOM marker; a Tool windows list; and a collapsed "2 chunks" disclosure.](/images/docs/session-resources-drawer.png)

On mobile the same panel fills the screen and scrolls, with the stat cards and the OOM banner
first so the answer is above the fold.

![The same Resources panel on a phone, filling the whole screen: the four stat cards stacked two by two, the amber OOM banner, the full timeline chart with its four-line legend and chunk I/O totals, and the first Tool windows row, with the rest reachable by scrolling.](/images/docs/session-resources-drawer-mobile.png)

## Where resource history exists — and where it doesn't

| Runtime                                                                        | Resource history |
| ------------------------------------------------------------------------------ | ---------------- |
| **VM-backed workspaces** (standard sessions and tasks)                         | Yes              |
| **[Instant sessions](/docs/guides/instant-sessions/)** (Cloudflare Containers) | No               |
| **[App deployment](/docs/guides/app-deployments/) nodes**                      | No               |

The collector runs in the VM agent when it holds the workspace role, which Instant containers do
not. Opening **Resources** on an Instant session shows _"No retained resource history is available
for this session yet."_ — that is the expected result, not a failure. The same message appears on a
brand-new VM session that has not yet finished its first [chunk](#chunks) — SAM uploads history in
15-minute slices — so give a young session a few minutes before concluding anything.

## Reading the panel

The drawer stacks its content top to bottom in the order you normally need it.

### Stat cards

Four numbers for the whole session:

| Card          | What it means                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **CPU peak**  | The busiest single sample, in milliseconds of CPU time. See the conversion below.                                                                          |
| **RAM peak**  | The highest total memory the container held at any sampled moment — **including page cache**, so read it with [this caveat](#what-this-does-not-tell-you). |
| **I/O total** | Bytes read and written over the session.                                                                                                                   |
| **Samples**   | How many observations were retained, and how many **gaps** there are (see [Gaps and resets](#gaps-and-resets)).                                            |

**Converting CPU peak to cores.** CPU is reported as CPU-milliseconds consumed per sample, and
SAM samples every 5 seconds by default (`RESOURCE_HISTORY_SAMPLE_INTERVAL`). One core running flat
out for a whole 5-second sample is 5,000 ms. So:

| CPU peak reads | Roughly               |
| -------------- | --------------------- |
| ~10,000 ms     | 2 cores saturated     |
| ~5,000 ms      | 1 core saturated      |
| ~4,120 ms      | 0.8 of a core         |
| ~1,200 ms      | a quarter of one core |

If your deployment changed the sampling interval, divide by that interval in milliseconds instead.

### The OOM banner

If the container hit its memory limit, an amber banner says so and counts the events. **This is
the single most useful thing on the page** — an out-of-memory kill is the usual explanation for an
agent that stopped mid-sentence, produced a truncated result, or reported a tool crash it could not
describe.

The count covers both an allocation that hit the limit and a process the kernel actually killed.

SAM does not just watch this happen: when the node evicts a workspace under memory pressure it
tries to preserve the session and bring it back through normal placement, so a single OOM does not
necessarily mean lost work. What it does not do is change the size for you — if a session keeps
hitting the limit, raise the memory the work asks for. See
[Right-sizing after you've read the history](#right-sizing-after-youve-read-the-history).

### The detail timeline

The chart loads automatically for the most recent slice of the session:

- **Green solid line** — CPU, normalized to this slice's own CPU peak.
- **Purple dashed line** — RAM, normalized to this slice's own RAM peak.
- **Blue bands** — tool windows: stretches where the agent had one or more tool calls in flight.
  A fainter band means SAM inferred the end of the window rather than observing it.
- **An amber marker at the top**, with a dashed line down the chart — an out-of-memory sample.
- **A small grey dot at the bottom** — a gap or a counter reset. Easy to miss, and worth not
  missing: see [Gaps and resets](#gaps-and-resets).

Each line is scaled to its **own** peak within the slice, so the two lines are shaped for reading
against the tool bands — not against each other. A tall green line does not mean CPU is higher
than RAM.

Under the chart sits its legend and the I/O read/write totals for this slice, then **Tool
windows** — each window with its start time, duration, and how many tool calls overlapped. Every
entry reads `acp_tool_call`: SAM records that a tool ran, not which one, so the list tells you
_when_ and _how long_, never _what_.

### Chunks

SAM stores the history in **chunks** — the drawer's word for one slice of time. A chunk closes
after 15 minutes by default (`RESOURCE_HISTORY_CHUNK_INTERVAL`), or sooner if it fills up or the
session ends, so the last one is usually short. The **N chunks** disclosure at the bottom is
collapsed until you open it; each row shows the start time, duration, sample count, stored size,
tool-window count, and gaps. Click one to load its timeline.

Only the chunk you select is fetched, so moving between slices costs one small request each rather
than downloading the whole session.

At the shipped defaults a chunk holds about 180 samples — 15 minutes at one sample every 5 seconds —
so the header reads a plain point count and the chart draws every sample. A chunk only exceeds the
720-point cap if a deployment samples faster than about every 1.25 seconds, lengthens the chunk
interval, or lowers `WORKSPACE_RESOURCE_DETAIL_MAX_POINTS`. When it does, the chart is thinned to
fit and the header switches to `<shown>/<total> points`. The
thinning keeps gaps and the highest CPU/memory sample from each slice of the chunk, so the busiest
moments survive; it does not specifically keep OOM samples, so an OOM marker can drop off a thinned
chart. The OOM banner and its count come from the stored summary and are never affected.

**The list is capped.** It shows the most recent 24 chunks
(`WORKSPACE_RESOURCE_LIST_LIMIT`) — about six hours of a continuously running session at the
default chunk interval. Older chunks are still stored and can still be fetched by ID, but nothing
enumerates them, so there is no way to page back to them from the panel. For a long overnight run,
the stat cards still cover the whole session; the per-sample timeline only covers the tail.

### Gaps and resets

A **gap** means SAM has no observations for a stretch — the node was rebooted, the agent restarted,
or telemetry could not be collected. A **counter reset** means the kernel counters the agent reads
went backwards, usually because the container was recreated.

Neither is an error. They matter because a gap is _not_ a period of zero usage: do not read a flat
line across a gap as "the agent was idle." The **Samples** stat card counts them, so when that card
says there were gaps, check the timeline for the grey dots before drawing conclusions from a quiet
stretch.

## What this does not tell you

The panel is easy to over-read. Four things it cannot tell you:

- **RAM peak is not "how much memory the program needed."** It is the container's total cgroup
  memory, which includes reclaimable page cache. A workspace that reads or writes large files —
  a clone, a build, a test run — climbs toward the machine's limit as a matter of course, with no
  memory pressure at all. **Treat the OOM banner, not RAM peak, as evidence that memory ran out.**
- **It is not per-process attribution.** Samples come from the workspace's cgroup — the whole
  container, including the agent harness, your dev server, test runners, and background jobs. A
  tool window that overlaps a CPU spike is a _correlation_, not proof that the tool caused the spike.
- **It does not sample disk space.** Only disk _I/O_ (bytes read and written). If you are chasing a
  "no space left on device" failure, this panel will not show it.
- **It does not explain what the agent was doing.** Tool windows are anonymous. SAM stores a hash
  of each tool-call ID, never the tool name, arguments, output, file paths, commands, or prompts.
  Pair the timeline with the chat transcript to work out the "what".

The drawer states the correlation caveat inline, under the chart, so nobody reads a chart in
isolation and reports a false cause.

## Was it working, or waiting?

A session that took an hour is not necessarily a session that did an hour of work. The timeline
separates the two:

- **Tool bands with CPU movement under them** — the agent was running something.
- **Tool bands with a flat CPU line under them** — the agent was blocked on something external: a
  network call, a provider API, a slow download, a human. Elapsed time in a tool window is not work.
- **No tool band at all** — the agent was not executing a tool. Between turns this usually means it
  was waiting for you; mid-turn it usually means it was generating text.

Only the first case is improved by a bigger machine. The other two are improved by changing what
the agent is waiting on.

## Right-sizing after you've read the history

The point of the panel is to make a machine-size decision with evidence instead of instinct.

**If you saw an OOM**, raise the memory floor. Set it at whichever level in the
[requirements chain](/docs/guides/compute-pools/#where-you-can-set-them) the problem belongs to —
the project default for "everything here needs more", the agent profile for "this agent is heavy",
the task itself for a one-off. Remember the host reserve: a 4 GiB machine can only back a ~3.5 GiB
reservation, so asking for exactly 4 GB pushes you onto an 8 GiB machine.

Do **not** use "RAM peak looks close to the machine size" as your trigger. That number includes
page cache (see [What this does not tell you](#what-this-does-not-tell-you)), so a workspace that
reads large files reaches it while having plenty of memory to spare. The OOM banner is the signal.

**If CPU peak never approached one core and there was no OOM**, you are likely paying for headroom
you never used. Lower the requirement, or set the pool's **Workspace strategy** to **Smallest fit**
so SAM stops reaching for big machines.

**If the timeline was mostly flat with long quiet stretches**, the session was waiting rather than
computing (see [above](#was-it-working-or-waiting)) — a bigger machine will not help.

See [Compute Pools](/docs/guides/compute-pools/#resource-requirements-how-much-machine-work-asks-for) for where
each requirement is set and how SAM picks a machine from it.

## How long it is kept

| Data                                     | Default retention | Setting                                     |
| ---------------------------------------- | ----------------- | ------------------------------------------- |
| Raw sample chunks (what the chart draws) | 90 days           | `WORKSPACE_RESOURCE_RAW_RETENTION_DAYS`     |
| Session summaries (the stat cards)       | 180 days          | `WORKSPACE_RESOURCE_SUMMARY_RETENTION_DAYS` |

Summaries outlive the raw chunks on purpose: the cheap "what did this peak at" answer stays
available for six months, while the expensive per-sample detail expires first. Once the chunks
expire, the stat cards remain and the chart is empty.

Deleting a project or a workspace deletes its resource history with it.

Self-hosters set both retentions, the chunk-list cap, and the detail-point cap as Worker variables —
the `WORKSPACE_RESOURCE_*` table under
[Configuration → Durable Object Limits](/docs/reference/configuration/#durable-object-limits).

The collection-side settings (`RESOURCE_HISTORY_SAMPLE_INTERVAL`, `RESOURCE_HISTORY_CHUNK_INTERVAL`,
and the spool bounds) are read by the VM agent itself — see the
[VM Agent configuration reference](/docs/reference/vm-agent/#configuration). SAM's deploy pipeline
does not currently pass them through cloud-init, so changing them means editing the agent's systemd
unit on the node; the defaults are what every managed node runs.

## What is actually stored

The retained payload is deliberately narrow: timestamps, CPU-milliseconds, memory bytes, I/O bytes,
process counts, OOM flags, and hashed tool-call IDs with their start and end times.

It contains **no** prompts, messages, commands, tool names, tool arguments, tool output, file paths,
environment variables, or secrets. That is what makes it safe to keep for months and safe to hand to
an agent.

## Asking an agent to read it

Agents connected to SAM's MCP server read the same data with the `get_resource_history` tool.
**Called with no arguments it returns the agent's own session** — which is the useful case, because
an agent can check whether it is heading for the same wall that killed the last attempt. Pass
`sessionId`, `taskId`, or `workspaceId` to look at a different scope — any one of them replaces the
agent's own scope rather than narrowing it — and `chunkId` to pull one slice's samples. Without `chunkId` it returns only the summary and chunk index, so a casual lookup
stays cheap. There is no `projectId` parameter — the project comes from the agent's connection.

This turns a vague complaint into a checkable one. For example:

> "Task `01M2…` failed near the end. Use `get_resource_history` for that task, tell me whether it
> hit an OOM, and if so what its RAM peak was."

The same information is available over HTTP at
`GET /api/projects/:projectId/sessions/:sessionId/resource-history` (also `…/tasks/:taskId/…` and
`…/workspaces/:workspaceId/…`), with an optional `?chunkId=` for detail.

## Troubleshooting

| What you see                                         | What it means                                                                                                                                                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "No retained resource history is available"          | An Instant session (never collected), a VM session younger than its first chunk, or a session whose raw chunks have passed their retention.                                                                    |
| Stat cards present, chart empty                      | The raw chunks expired but the summary is still in retention. The peaks are still trustworthy; the per-sample detail is gone.                                                                                  |
| "Resource history could not be loaded."              | The request failed. Reopen the drawer; if it persists, [report it](/docs/guides/reporting-issues/) from the same rail.                                                                                         |
| A long flat stretch in the middle of a busy session  | Check the **Samples** card for a gap count, then look for a grey dot on the timeline. (The legend calls these "dashed markers", but a gap currently draws only the dot.) A gap is missing data, not idle time. |
| A tool window with no CPU or RAM movement under it   | The agent was waiting on something external. Tool windows measure elapsed time, not work done.                                                                                                                 |
| Tool windows drawn fainter, marked `approximate end` | SAM inferred the window's end at the end of the agent's turn rather than observing the call report back. This is routine for some agents — treat the duration as approximate.                                  |
| You want a slice from earlier than the listed chunks | The panel lists only the most recent chunks (see [Chunks](#chunks)). Older slices are stored but nothing enumerates them.                                                                                      |
