---
title: AI models for agents
description: Let agents call Cloudflare-hosted AI models, such as decision, extraction, text, speech and image models, within a monthly budget you set.
---

While an agent works, it can call other AI models besides its own chat model. For example, it can:

- ask a decision model a yes/no question and get back a probability
- pull typed fields out of a log
- transcribe a recording
- get a second opinion from another chat model

SAM gives agents two tools for this, `list_ai_models` and `run_ai_model`. The models are the ones Cloudflare runs itself on [Workers AI](https://developers.cloudflare.com/workers-ai/models/). That includes GLM, Gemma, gpt-oss, Whisper, FLUX, Cloudflare's own Clef decision models and the Clairic extraction model. Third-party models that Cloudflare only proxies are not included.

## What is on by default

A project that has not chosen its own models lets agents call the very cheap ones:

- **Decision**: Clef, Clef-flash and Clef-omni. They answer typed yes/no, choice or score questions with probabilities.
- **Extraction**: Clairic. It pulls dates, numbers, lists and other typed fields out of text or images.
- **Classification**: sentiment, image and reranking classifiers.

Each project also has a monthly spending limit for these calls, $5 by default.

## Choose the models for a project

Open **Project settings → Agents → AI Models**. Here you can:

- see this month's spend against the limit ("$1.20 of $5.00 used this month"), when it resets, and
  which models were used
- select **Choose models** to turn models on and off, grouped by what they do, with their published
  prices, or **Use recommended** to go back to SAM's choice
- change **Monthly limit (USD)** and **Save**, or **Use default** to go back to the default. The
  most you can set is shown under it, $50 a month unless your SAM administrator changed it.

<picture>
  <source media="(max-width: 40em)" srcset="/images/docs/agent-models-settings-mobile.png 2x" />
  <img src="/images/docs/agent-models-settings.png" alt="The AI Models section of a project's Agents settings. It reads '$1.20 of $5.00 used this month', resets Nov 1, with a progress bar. Below are Monthly limit (USD) set to 5 with Save, and 'Up to $50.00 · Default: $5.00'. Used this month lists clef-flash, 61 calls · $0.84, and clairic, 25 calls · $0.36. The last line reads 'Recommended · 7 models (Decision 3 · Extraction 1 · Classification 3)' beside Choose models." />
</picture>

Project owners and admins can change these settings. Other members can see them. When this month's
limit is used up, the section says so and offers **Raise limit**. If it says **Turned off by your
SAM administrator.**, no project can call models until a superadmin turns them back on.

## Give a profile or skill its own models

An [agent profile](/docs/guides/agents/#agent-profiles) or a skill can choose its own models instead of using the project's. Open the profile or skill and set **AI models this profile can call** (or **this skill can call**) to **Choose models**.

The most specific choice wins: a skill's choice beats its profile's, and a profile's beats the project's. Choosing no models at all turns model calls off for agents using that profile or skill.

Agents cannot change these settings themselves. Turning on a model or raising the limit is always a person's decision.

## Tell agents when to use them

SAM does not decide which model an agent should call. Put that guidance where your agents already read instructions, such as `AGENTS.md`, `CLAUDE.md` or a profile's instructions. For example:

```markdown title="AGENTS.md"
- Before you report a task as done, ask @cf/cloudflare/clef-flash whether the test output
  shows every test passing. Only report done when the probability is above 0.95.
- To pull error codes and timestamps out of long logs, use @cf/cloudflare/clairic.
- Transcribe voice notes in `notes/` with @cf/openai/whisper-large-v3-turbo.
```

## How agents call a model

`list_ai_models` returns the models the agent may call, their prices and the budget left. Called with `{ "model": "<id>" }`, it returns that model's full input schema.

`run_ai_model` sends an input to one model and returns its output, the cost of the call and the budget left:

```json title="run_ai_model"
{
  "model": "@cf/cloudflare/clef-flash",
  "input": {
    "model": "clef-flash",
    "state": "12 passed, 0 failed",
    "questions": { "done": { "type": "noul", "instructions": "Did every test pass?" } }
  }
}
```

**Files.** Files move through the agent's workspace, never through its conversation.

- **Sending a file:** put `{ "$file": "path/in/workspace" }` anywhere in the input. SAM reads that file and sends its contents, base64-encoded by default. Add `"encoding": "bytes"` or `"encoding": "data-url"` when the model expects those formats. A file sent as `"bytes"` becomes a list of numbers several times its size, so it counts three times against the request limit; use base64 for large files.
- **Images, audio and very large outputs:** these are saved into the workspace under `.ai-outputs/`, or under the `outputDirectory` the agent chooses. The result names the saved file.

## When a call is refused

The agent gets the reason, and usually tells you. What each means:

| The agent reports                                             | What to do                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| "…is not turned on for this agent…"                           | Turn the model on in **Project settings → Agents → AI Models**, or in the profile or skill if it chooses its own models |
| "This project's monthly AI model budget is used up…"          | Wait for the date it gives, or select **Raise limit**                                                                   |
| "…is not in Cloudflare's hosted model catalog…"               | The model ID is wrong, or the model isn't one Cloudflare runs itself. Ask the agent to pick one from `list_ai_models`   |
| "…only works over a realtime (websocket) connection…"         | That model can't be called this way                                                                                     |
| "Agent model calls are turned off by your SAM administrator." | Ask a superadmin to turn them back on in **Admin → Settings → AI models**                                               |

## Budget and costs

- Spend is estimated from Cloudflare's published price for each model. Before a call runs, SAM holds an estimate. After it finishes, SAM charges what the model reports it used.
- Once a project reaches its limit, calls are refused until the start of the next month (UTC), or until an owner or admin raises the limit.
- Calls running at the same time cannot overspend the limit: each one must fit before it starts.
- Some models have no published price. Those are charged a fixed estimate per call, $0.01 by default.
- The real bill goes to the Cloudflare account that runs SAM. For a self-hosted SAM, that is your account.
- A call stops after 55 seconds by default, just under the 60-second limit some agents put on a tool call. For long answers from big models, ask for a lower `max_tokens`. Streaming responses and realtime (websocket-only) models are not supported.

## For administrators

Superadmins can tune this feature under **Admin → Settings → AI models**. The available settings are listed in [Admin settings](/docs/guides/admin-settings/#ai-models), including a switch that turns agent model calls off for every project.
