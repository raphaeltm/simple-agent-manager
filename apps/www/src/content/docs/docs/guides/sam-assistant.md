---
title: Private SAM Assistant
description: Enable your private account assistant, coordinate project work, and review its action receipts.
---

The optional SAM assistant gives you one private account conversation for checking projects and coordinating work. It starts **off**. In **Settings**, turn on **SAM assistant**, then select **Open SAM**. The SAM destination also appears in desktop and mobile navigation while enabled. An installation administrator can make the assistant unavailable independently of your preference.

## What you can do

Ask for project and inbox status, find or refine ideas, inspect available profiles, start project work, read task reports, or send a follow-up to an existing project session. Name the project and preserve any profile, branch, review, or deployment constraints in your request. SAM should clarify an ambiguous target before changing project state.

Requests that require reading or changing repository files run in a visible project task/session. Follow **Open source work** or **Open project work** to inspect the actual conversation and results. A request being accepted, an agent reporting completion, and independently verified results are different states.

Use voice input to transcribe a message into the composer. You still review and send that text yourself.

## Review actions and recover safely

Actions that require confirmation show their exact recorded input before **Confirm this action** or **Decline**. Agent forms containing sensitive values must be completed directly in the linked project session. Do not paste secrets into the account conversation.

A failed send keeps the pending message in the same browser tab so **Retry message** can reuse its request identity, including after refresh. If a dispatch outcome is uncertain, **Check outcome** looks for the already-reserved work; it does not create a replacement task. An unresolved outcome is not evidence that nothing happened.

If SAM cannot substantiate a draft answer before attempting any tool, it can make one bounded correction before replying. An interrupted answer can mean it still could not substantiate its response. Review the recorded actions before asking it to continue; interruption does not undo an action that already completed.

**Stop SAM turn** stops the account assistant's current turn. Project work already dispatched continues until stopped through its own controls. Turning SAM off prevents new assistant actions and keeps your history and existing project work.

## History and updates

The conversation initially loads a recent window. **Load older messages** retrieves more turns. **Earlier SAM history**, when present, opens retained messages from the earlier assistant as read-only history.

Project work has expandable status cards with source links and observation times. Background updates stay in those cards instead of taking over the conversation. **Mark seen** clears their unseen indication; it does not answer a question or grant an agent permission.

Your account conversation is private. A project task is visible according to that project's access rules. SAM should pass only the brief needed for the project request, without copying unrelated account history, personal preferences, or other-project details.

## Current limits

Settings, connections, compute pools, automation, and deployments remain in their existing pages. The assistant exposes a reviewed subset of platform operations, not every operation available through the UI or connector. Watches of dispatched work expire and do not imply indefinite monitoring. The launch interface has no conversation-fork control; a private fork API exists for clients, without copying project actions or granting additional access.

These instructions describe the implemented interface and contract; they do not certify that a particular installation has deployed or live-verified this version. See [configuration](/docs/reference/configuration/#private-sam-assistant-runtime-controls) and the [API contract](/docs/reference/api/#private-sam-account-assistant) for operator details.
