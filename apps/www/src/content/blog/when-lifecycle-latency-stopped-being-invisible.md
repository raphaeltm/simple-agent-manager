---
title: 'Lifecycle Latency: Catching Slow Work Automatically'
date: 2026-11-04
author: SAM
category: engineering
tags: ['cloudflare-workers', 'd1', 'performance', 'reliability']
excerpt: 'A workspace cleanup once took about 31 minutes without an automated alarm. We added a Cloudflare Workers watchdog and daily D1 latency check to make slow lifecycle work visible.'
---

A workspace cleanup in SAM once sat in `stopping` for about 31 minutes before the system confirmed it was done. We fixed the slow cleanup, then added something we were missing: an automatic way to notice when lifecycle work takes too long. The new monitor samples short-lived states, records over-budget episodes, and checks daily for broader slowdowns.

That idea applies to any service with work that moves through temporary states: deploying, deleting, recovering, or waking a session. A status tells you where work is. Measuring how long it stays there tells you when progress has stopped looking normal.

## The gap between “still working” and “too slow”

SAM already had timeouts for some hard failures. But no regular check asked whether a workspace, node, session sleep, or session wake had spent an unusually long time in a state that should finish within minutes.

The 31-minute cleanup made that gap concrete. A workspace with roughly 10,000 files was being deleted in small batches, one attempt per minute. Retries backed off, so the control plane did not confirm completion for about half an hour. The code was eventually fixed to do bounded work in each attempt and wake its reconciler promptly. But we also needed a way to catch the next slow path before it went unnoticed for days.

## Sample the state instead of instrumenting every writer

These state changes happen across API routes, Cloudflare Durable Objects, scheduled jobs, and the Go VM agent. Having every code path report a timestamp would create many places to keep consistent.

Instead, a Cloudflare Workers watchdog runs every five minutes and reads the relevant status columns in D1. It records when it first sees a workspace, node, session sleep, or session wake in a watched state. When the state changes, it closes that observation as an episode.

For example, the default budget for a workspace in `stopping` is 10 minutes. If the watchdog sees the same stop episode past its budget, it records a warning in the platform error store. It reports an episode once, while allowing a later stop of the same workspace to raise a new warning.

Sampling is a practical tradeoff: an episode may be noticed up to five minutes after it begins, and work that starts and finishes between samples will not be recorded. We keep this monitor focused on work that is unexpectedly lingering, not as a stopwatch for every operation.

## Why D1 triggers were the wrong shortcut

The first design used D1 triggers to record each status change. It looked like the cleanest way to observe changes no matter which part of SAM made them.

Staging showed a subtle problem: D1 includes trigger writes in its change count. Some existing code uses that count to check that exactly one row was updated. A trigger turned a one-row update into a reported count of three, causing a provisioning safety check to reject a VM it had just created.

We removed the triggers and changed the watchdog to sample state instead. The lesson is broader than this monitor: database automation can change the meaning of results that application code already relies on. A trigger may look invisible, but its writes still affect the database contract.

The monitor stores observations and completed episodes in separate D1 tables. It does not write to the status rows, so a monitoring feature cannot accidentally change the lifecycle it is measuring.

## Look for regressions, not only individual stalls

A five-minute watchdog can flag one operation that stays stuck. A separate daily check looks for slower patterns across many completed episodes.

For each watched state, the daily check calculates the median, 95th percentile, and longest observed duration over the last 24 hours. It compares the p95 with that state’s configured budget and with the previous seven days. With enough samples, a result over either threshold is saved as a platform warning for the existing feedback and incident workflow.

Percentiles help distinguish one outlier from a system-wide slowdown. If one cleanup takes a long time, the maximum exposes it. If the p95 rises, a meaningful slice of recent work is slowing down. The seven-day comparison can catch a regression even when operations remain under a generous absolute budget.

The budgets and sample limits are admin settings. Operators can tune how long each state may run, disable an individual watch with a zero budget, and adjust how much history the daily comparison keeps.

## Make latency part of reliability

The watchdog gives us a way to notice lingering work. The daily check gives us a way to see when normal work is getting slower. Neither replaces fixing the operation itself, but both shorten the distance between a regression and evidence that something changed.

We want this pattern wherever a lifecycle has a clear beginning, an expected duration, and a useful alert path. When software manages machines and workspaces on a user’s behalf, “eventually finished” is not enough. The system should know when eventually is taking too long.
