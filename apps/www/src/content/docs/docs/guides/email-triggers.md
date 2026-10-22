---
title: Email Triggers (preview)
description: Give an automation its own email address. Mail from people you allow starts its agent, and the agent can reply by email.
---

:::caution[Preview]
Email triggers are a preview. They run only on deployments where agent email is configured (today:
staging). The address is the main protection, so treat it like a password. See
[Security](#security) for the details and what is still missing.
:::

An email trigger gives an automation its own address, such as
`agent+k3j2h7m9q2xw4n8p@mail.your-domain.com`. When someone you allow emails that address, SAM
starts the automation's agent with the email in its prompt. The agent can answer by email, and the
reply arrives in the sender's inbox as a normal threaded reply. For schedule, GitHub and webhook
triggers, see [Triggers](/docs/guides/triggers/).

## Create one

1. Open the project, select **Automation**, then **New automation**, and choose **By email**.
2. Under **Allowed senders**, list the addresses that may start it. It starts with your own
   account email. Mail whose `From:` address is not on the list is refused. SAM matches the
   `From:` address; it cannot yet verify who really sent the email (see [Security](#security)).
3. Pick the **Agent**. Email automations always need an explicit agent profile.
4. Write what it should do. The starting prompt passes the email to the agent and asks it to
   reply when it is done.
5. Save. The automation's page shows its address with a **Copy** button.

Email triggers cannot be started with **Run now**: there would be no email to answer.
**Try it with a sample** still previews the prompt with an example email.

## What the agent sees

| Variable                                            | Meaning                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `{{email.from}}`, `{{email.fromName}}`              | The sender's address and display name                               |
| `{{email.to}}`                                      | The automation's address                                            |
| `{{email.subject}}`                                 | The subject                                                         |
| `{{email.text}}`                                    | The plain-text body (HTML-only mail is converted to text)           |
| `{{email.attachments}}`                             | One line per attachment: name, type and size. Contents are not kept |
| `{{email.receivedAt}}`, `{{email.messageId}}`       | When it arrived, and its `Message-ID`                               |
| `{{trigger.*}}`, `{{project.*}}`, `{{execution.*}}` | The same identity fields as other triggers                          |

Long bodies are cut at the **agentEmail.maxBodyChars** admin setting (12,000 characters by default)
and the prompt says so.

## Replies

The agent replies with the `reply_to_email` tool. A reply:

- goes only to the person who sent the email, never to anyone else on the thread;
- comes from the automation's own address, with the automation's name as the sender name;
- is threaded under the original email (`In-Reply-To` and `References`);
- is plain text;
- is marked `Auto-Submitted: auto-replied`, so out-of-office responders and other agents do not
  answer it.

Each run can send up to **agentEmail.maxRepliesPerRun** replies (5 by default). Failed attempts
count. A reply from the sender starts a new run with the earlier messages quoted, the way most mail
apps quote them.

## What SAM refuses

SAM refuses these during delivery, so the sender's mail server reports the failure and nothing
starts:

- a sender that is not on **Allowed senders**;
- automatic mail: `Auto-Submitted` replies, `Precedence: bulk`, list mail, and bounces;
- mail larger than **agentEmail.maxInboundBytes** (5 MiB by default);
- mail without a `Message-ID`;
- more than **agentEmail.inboundPerTriggerPerHour** emails to one address in an hour (20 by
  default);
- mail to a paused automation, or while it is already running as many copies as it allows.

If the same email is delivered twice, the second delivery is acknowledged without starting another
run.

## Security

- **The address is the key.** Its 16-character random part cannot be guessed. Anyone who learns it
  can try to email it, so share it only with the people on **Allowed senders**.
- **Sender checks are limited.** Cloudflare rejects mail that fails both SPF and DKIM, and mail
  that fails the sending domain's DMARC policy. It does not tell SAM the results, so SAM cannot yet
  confirm the `From:` address itself. Someone who knows the address could fake an allowed sender at
  a domain whose DMARC policy is `p=none`. Verifying the sender's DKIM signature inside SAM is
  required before this leaves preview.
- **Prefer senders whose domain enforces DMARC.** Until then, an allowed sender at a domain that
  publishes `p=quarantine` or `p=reject` is much harder to fake than one at a domain with `p=none`
  or no DMARC record. Any DMARC lookup tool shows a domain's policy.
- **An email can ask the agent to do anything the automation's agent can do.** Give email
  automations a profile with only the access they need.

## Check that it works (admins)

**Admin → Integrations → Agent email** shows whether agent email is on and its domain. It can send
a fixed loopback test: add `agent+loopback@mail.<your-domain>` to an automation's
**Allowed senders**, then send the test to that automation's address. Its agent starts, and when it
replies, the reply comes back to SAM and appears under **Last reply received**. The same is
available through [`/api/admin/agent-email`](/docs/reference/api/#agent-email-preview).

Cloudflare's Email Routing summary lists every reply an agent sends as **dropped**, even when it was
delivered. Check Email Sending's metrics and logs for replies instead.

## Set it up (self-hosting)

Agent email needs Cloudflare Email Routing and Email Sending (Workers Paid) on your zone, plus three
more permissions on the deploy token. See the agent email note in
[Self-Hosting](/docs/guides/self-hosting/). The deploy configures only `mail.<your-domain>`. It
skips any zone whose main domain already receives mail elsewhere, and the production deploy does not
turn the preview on.

After the first deploy, Cloudflare verifies the new sending records, usually within 5 to 15
minutes. Mail can arrive before then, but replies fail until it finishes. The deploy log says when
verification is still pending.
