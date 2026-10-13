---
title: SAM CLI
description: Install the sam command-line tool, sign in, and start, follow, and reply to work from a terminal or a script.
---

The `sam` command-line tool does from a terminal much of what you do in SAM's web app: list your
projects, start a chat, read it and reply, wait for a task to finish, and look at almost anything
the app shows. It suits scripts, and coding assistants on your own computer that need to hand work
to SAM. Claude Code and Codex can instead use SAM as a set of tools, through the
[SAM Connector](/docs/guides/sam-connector/#command-line-clients).

## Install

Open **Tools** in SAM's main navigation, then **SAM CLI**. The page has downloads for macOS (Apple
Silicon and Intel) and Linux (x86_64 and ARM64), and a one-line install command for your computer
that looks like this, with your installation's address already filled in:

```sh
curl -fsSL "https://api.example.com/api/cli/download?os=darwin&arch=arm64" -o sam && chmod +x sam && sudo mv sam /usr/local/bin/
```

The one-liner picks Apple Silicon on any Mac; on an Intel Mac, use the **macOS Intel** download, or
change `arch=arm64` to `arch=amd64`. Ignore the quick-start steps further down that page: they're out
of date, and on a self-hosted installation they would sign you in to the hosted service. Sign in as
described below instead.

## Sign in

```sh
sam auth login
```

The CLI prints a link and a code and opens your browser at **Authorize SAM CLI**, with the code
filled in. Check that it matches the one in your terminal, select **Authorize**, and go back to the
terminal: the CLI prints who you signed in as and keeps the session for later commands.
`sam auth status` shows which SAM address and saved session it's using.

- **Self-hosted SAM:** add your installation's API address the first time, for example
  `sam auth login --api-url https://api.your-domain.com`. It's your SAM web address with `app.`
  changed to `api.`. Without it, the CLI uses the hosted service.
- **Scripts and CI:** create an API token under **Settings → Access → API Tokens** and set it as
  `SAM_API_TOKEN` (and, for a self-hosted SAM, `SAM_API_URL` to the API address) in the
  environment. The CLI signs in with them on its own, with nothing saved on the machine.

## Pick a project

```sh
sam projects                      # your projects, with their names and IDs
sam project use checkout-service  # a name or ID from that list; later commands use it
sam status                        # the project and its active chats
```

Any command also takes `--project <name-or-id>` instead.

## Start and follow work

```sh
sam chat new "Find out why the checkout tests are flaky"   # start a Chat
sam chat                                                    # list the project's chats
sam chat <session-id>                                       # read the newest messages
sam chat send <session-id> "Leave the payment tests alone"  # reply
```

`sam chat new` always starts a **Chat**. For work you want delivered as a pull request, submit a
**Task** with a profile that runs on a VM (see [Chat or Task](/docs/guides/chat-features/#chat-or-task)),
then wait for it:

```sh
sam tasks submit --mode task --agent-profile "Build and test" --prompt "Add retries to the webhook sender"
sam tasks wait <task-id> --timeout 30m
```

Both accept `--agent-profile <name>` to choose who does the work; without it, the project's default
agent settings apply. Without `--mode task`, `sam tasks submit` follows the profile's **Task
Mode**. `sam tasks wait` stops waiting at the timeout but doesn't cancel the task. Add
`--json` to any command for output a script can read.

## More commands

`sam --help` lists the main commands, and `sam <command> --help` explains one. Beyond starting work,
the CLI can export a whole chat, answer an agent's question, put a chat to sleep, fork or retry a
session, and read ideas, profiles, skills, files, library documents, events, triggers, and
deployments. It can't change permissions, credentials, billing, or deployments.
[CLI project workflows](/docs/reference/cli-project-workflows/) is the full reference, including how
retries avoid starting the same work twice.
