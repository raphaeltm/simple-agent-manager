---
title: Private SAM Assistant
description: Enable your private account assistant, coordinate project work, and review its action receipts.
---

The optional SAM assistant gives you one private account conversation for checking projects and coordinating work. It starts **off**. In **Settings**, turn on **SAM assistant**, then select **Open SAM**. The SAM destination also appears in desktop and mobile navigation while enabled. An installation administrator can make the assistant unavailable independently of your preference.

## What you can do

Ask for project and inbox status, find or refine ideas, inspect available profiles, start project work, read task reports, or send a follow-up to an existing project session. Name the project and preserve any profile, branch, review, or deployment constraints in your request. SAM should clarify an ambiguous target before changing project state.

Requests that require reading or changing repository files run in a visible project task/session. Follow the **Open chat** (or **Open task**) link on an action or project work card to inspect the actual conversation and results. A request being accepted, an agent reporting completion, and independently verified results are different states.

Use the microphone button to transcribe a message into the composer. You still review and send that text yourself. On desktop, Ctrl+Enter (Cmd+Enter on a Mac) sends; Enter adds a new line.

## Follow an answer as it is written

While SAM works, its reply shows what it is doing right now: **Thinking**, **Working** or **Writing**, with the time elapsed. Each step appears as a plain line when it starts and is updated when it finishes, for example _Looking through your 20 most recent tasks…_ becoming _Read 20 recent tasks_. While it thinks, the latest line of its reasoning is shown in italics. The answer then appears word by word.

The live view is a preview of the stored reply. Text that refers to a project, task or chat appears only once a completed step in the same turn returned that item, so a guessed identifier or link is never shown while SAM is still writing. When the turn ends, the stored answer and its receipts replace the live view.

For questions about current work, such as what shipped or changed recently, SAM is told today's date and reads live project data in that turn. Earlier messages in your SAM history carry their dates and count as past context, not current status.

## Review actions and recover safely

Actions that require confirmation say what will happen and in which project, and link to the target so you can review it first. Confirm with the action's own button, such as **Confirm stop**, or decline it, such as **Keep running**. **Exact request** shows the exact recorded input. Agent forms containing sensitive values must be completed directly in the linked project session. Do not paste secrets into the account conversation.

A failed send keeps the pending message in the same browser tab so **Retry** can reuse its request identity, including after refresh. If a dispatch outcome is uncertain, **Check outcome** looks for the already-reserved work; it does not create a replacement task. An unresolved outcome is not evidence that nothing happened.

If SAM cannot substantiate a draft answer before attempting any tool, it can make one bounded correction before replying. An interrupted answer can mean it still could not substantiate its response. Review the recorded actions before asking it to continue; interruption does not undo an action that already completed.

While SAM is working, **Stop** replaces **Send** and stops the account assistant's current turn. Project work already dispatched continues until stopped through its own controls. Turning SAM off prevents new assistant actions and keeps your history and existing project work.

## History and updates

The conversation initially loads a recent window. **Load older messages** retrieves more turns. **Earlier SAM history**, when present, opens retained messages from the earlier assistant as read-only history.

**Project work**, above the conversation, summarizes work SAM started and counts items that need attention or have new updates. Expand it for status cards with links and observation times. Background updates stay there instead of taking over the conversation. **Mark seen** clears their unseen indication; it does not answer a question or grant an agent permission.

Your account conversation is private. A project task is visible according to that project's access rules. SAM should pass only the brief needed for the project request, without copying unrelated account history, personal preferences, or other-project details.

## Current limits

Settings, connections, compute pools, automation, and deployments remain in their existing pages. The assistant exposes a reviewed subset of platform operations, not every operation available through the UI or connector. Watches of dispatched work expire and do not imply indefinite monitoring. The launch interface has no conversation-fork control; a private fork API exists for clients, without copying project actions or granting additional access.

These instructions describe the implemented interface and contract; they do not certify that a particular installation has deployed or live-verified this version. See [configuration](/docs/reference/configuration/#private-sam-assistant-runtime-controls) and the [API contract](/docs/reference/api/#private-sam-account-assistant) for operator details.
