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

The one-liner picks Apple Silicon on any Mac; on an Intel Mac, use **Other platforms → macOS
Intel**, or change `arch=arm64` to `arch=amd64`. Ignore the quick-start steps further down that
page: they're out of date, and their sign-in step points the CLI at the hosted service even on a
self-hosted installation. Sign in as described below instead.

## Sign in

```sh
sam auth login
```

The CLI prints a link and a code and opens your browser at **Authorize SAM CLI**, with the code
filled in (sign in to SAM first if it asks). Check that the code matches the one in your terminal,
select **Authorize**, and go back to the terminal: the CLI prints who you signed in as and keeps the session for later commands.
`sam auth status` shows which SAM address and saved session it's using.

- **Self-hosted SAM:** add your installation's API address the first time, for example
  `sam auth login --api-url https://api.your-domain.com`. It's your SAM web address with `app.`
  changed to `api.`. Without it, the CLI uses the hosted service.
- **Scripts and CI:** create an API token under **Settings → Access → API Tokens** and set it as
  `SAM_API_TOKEN` (and, for a self-hosted SAM, `SAM_API_URL` to the API address) in the
  environment. The CLI then signs in for each command and saves nothing, so `sam project use`
  doesn't work: pass `--project` every time. SAM allows 20 of these sign-ins an hour from one IP
  address. For more, sign in once with `sam auth login --token "$SAM_API_TOKEN"` (adding `--api-url`
  for a self-hosted SAM) and leave `SAM_API_URL` unset, so later commands use that saved sign-in.

## Pick a project

```sh
sam projects                      # your projects, with their names and IDs
sam project use checkout-service  # later commands use this project
sam status                        # the project and its active chats
```

`sam projects` shortens IDs, so give `sam project use` a name, or the start of an ID without the
`...`. Any command also takes `--project <name-or-id>` instead.

## Start and follow work

```sh
sam chat new "Find out why the checkout tests are flaky"   # start a Chat
sam chat                                                    # list the project's chats
sam chat <session-id>                                       # read the newest messages
sam chat send <session-id> "Leave the payment tests alone"  # reply
```

`sam chat new` prints the new chat's `sessionId` in full. The list from `sam chat` (and `sam status`)
shortens IDs to their first seven characters, which `sam chat <session-id>` and `sam chat send`
don't accept: copy the full ID from `sam chat --json`, or from the chat's address in SAM
(`…/chat/<session-id>`).

`sam chat new` always starts a **Chat**. For work you want delivered as a pull request, submit a
**Task**, usually with a profile that runs on a VM so the agent can build and test (see
[Chat or Task](/docs/guides/chat-features/#chat-or-task)), then wait for it:

```sh
sam tasks submit --mode task --agent-profile "Build and test" --prompt "Add retries to the webhook sender"
sam tasks wait <task-id> --timeout 30m
```

`sam chat new` and `sam tasks submit` both accept `--agent-profile <name>` to choose who does the
work. Without it, they start on a VM with the project's default agent settings, even where the web
app would start an Instant chat; to start on Instant, name an
[Instant](/docs/guides/instant-sessions/) profile. Without `--mode task`, `sam tasks submit` follows
the profile's **Task Mode**. `sam tasks wait` stops waiting at the timeout but doesn't cancel the
task. Add `--json` to any command for output a script can read.

## More commands

`sam --help` lists the commands, and `sam chat --help` or `sam tasks --help` lists a group's
subcommands and flags (`sam chat new`, plain `sam chat`, and `sam chat <session-id>` are only in
`sam --help`). Beyond starting work, the CLI can export a whole chat, put a chat to sleep, fork or
retry a session (without `--launch` it only prints the prompt it would send; `--launch` starts the
work like `sam tasks submit`, so it runs on a VM with the project's default agent settings unless
you add `--agent-profile`, and usually as a **Task** unless you add `--mode conversation`), and read ideas, profiles, skills, files, library documents, events, triggers, and
deployments. It can answer a question an agent asked with `request_human_input` by picking one of
its choices; permission requests, question cards, and requests to open a link need SAM itself or the
Connector. It can't change permissions, credentials, billing, or deployments.
[CLI project workflows](/docs/reference/cli-project-workflows/) is the full reference, including how
retries avoid starting the same work twice.
