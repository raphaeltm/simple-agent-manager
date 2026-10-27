---
title: Email Triggers (preview)
description: Give an automation its own email address. Mail from people you allow starts its agent, and the agent can reply by email.
---

:::caution[Preview]
Email triggers are a preview. They only appear once a superadmin has turned agent email on for your
SAM installation (see [Turn on agent email](#turn-on-agent-email-admins)); until then, **By email**
isn't offered in **New automation**. The address is the main protection, so treat it like a
password. See [Security](#security) for the details and what is still missing.
:::

An email trigger gives an automation its own address, such as
`agent+k3j2h7m9q2xw4n8p@agents.your-domain.com`. When someone you allow emails that address, SAM
starts the automation's agent with the email in its prompt. The agent can answer by email, and the
reply arrives in the sender's inbox as a normal threaded reply. For schedule, GitHub and webhook
triggers, see [Triggers](/docs/guides/triggers/).

## Create one

1. Open the project, select **Automation**, then **New automation**, and choose **By email**.
2. Under **Who can start it?**, list the **Allowed senders**, one address per line (up to 20 by default). It
   starts with your own account email. Mail whose `From:` address is not on the list is refused.
   SAM matches the `From:` address; it cannot yet verify who really sent the email (see
   [Security](#security)).
3. Pick the **Agent**. Email automations always need an explicit agent profile.
4. Write what it should do. The starting prompt passes the email to the agent and asks it to
   reply with the `reply_to_email` tool when it is done.
5. Save. The automation's page shows **Its email address**, with a copy button.

Everyone in the project can see the address on that page.
Email automations have no **Run now** (there would be no email to answer) and no sample preview:
**Try it with a sample** is only for webhook automations. You can still change who may use one,
pause it, or delete it.

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

## When the agent cannot start right away

Once an email passes these checks, SAM stores it before answering the sender's mail server, so it
is not lost if SAM cannot start the agent right away. The stored text is deleted once the run
starts or SAM gives up on the email. SAM then retries on its own, in the
background, with the same run each time, so an email never starts two runs:

- up to **agentEmail.maxDeliveryAttempts** attempts in all (5 by default);
- the first retry after **agentEmail.retryBaseSeconds** (60 by default), then twice as long each
  time, at most **agentEmail.retryMaxSeconds** apart (900 by default).

On a retry, an automation that is still busy counts as a failed attempt rather than a refusal. If
every attempt fails, SAM gives up on that email, and superadmins get a notification titled
"Operational sweep failed: agent_email_delivery_gave_up" (at most one an hour). Before giving up,
SAM checks whether the run started after all, for example when an attempt timed out after creating
it. If it did, the email counts as delivered. Once SAM has given up on an email, a late attempt can
no longer start a run for it. The background retry waits for one attempt at most
**agentEmail.processingLeaseSeconds** (120 by default), then moves on to the next email.

The sender's mail server sees a temporary failure only if SAM could not store the email at all.

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

## Turn on agent email (admins)

Agent email needs Cloudflare Email Routing and Email Sending (Workers Paid) on the zone SAM uses,
and it uses the subdomain `agents.<your-domain>`. Turning it on takes two steps, and neither needs
the Cloudflare dashboard.

1. **Deploy with the right token permissions.** The deployment's Cloudflare token needs **Zone →
   Zone Settings → Edit**, **Zone → Email Routing Rules → Edit** and **Email Sending → Edit**. With
   them, every deploy prepares email: it sets up Email Sending for `agents.<your-domain>` and writes
   DNS records only under that subdomain. Without them, email stays off and the deploy log says so.
   No GitHub variable is needed. See [Self-Hosting](/docs/guides/self-hosting/).
2. **A superadmin turns it on.** Open **Admin → Integrations**. The **Agent email** section says
   **Off** and what's next:
   - "This deployment has not prepared agent email…", "Email Sending is not set up…" or "Deploy
     again: this deployment predates the agent email setup.": go back to step 1.
   - "Cloudflare is still verifying the sending records…": wait, usually 5 to 15 minutes after the
     deploy, and select **Check again**.
   - A refusal: fix your DNS as the table below says, then select **Check again**.
   - "Turning it on sets up Email Routing for agents.&lt;your-domain&gt;…": select **Turn on agent
     email**.
   - **Review DNS and routing changes**: when your main domain's records also need to change, the
     panel lists each change, such as "Removes TXT example.com — v=spf1 …" and "Adds TXT
     example.com — v=spf1 … include:_spf.mx.cloudflare.net ~all". Tick **I have reviewed and approve
     these DNS and routing changes**, then select **Turn on agent email**.

   The section then reads **On — agents.&lt;your-domain&gt;**. Send a loopback test to check it (see
   [Check that it works](#check-that-it-works-admins)).

What can change on your main domain:

- Mail delivery doesn't move: your MX records stay as they are.
- In a zone that has never used Email Routing, Cloudflare needs an SPF entry and a DKIM key on the
  main domain. If you already have an SPF record, setup replaces it with one record that keeps all
  your senders and adds Cloudflare's; it never adds a second SPF record. A Google Workspace domain
  without SPF gets a policy that authorizes both Google and Cloudflare.
- Subaddressing is a setting for the whole zone. Turning it on means mail to `name+anything@` your
  main domain goes where mail to `name@` goes, so the panel lists it when it's off.

Your approval covers exactly the changes the panel showed. If they differ when you press the button,
SAM says "What turning agent email on would change is different from what you allowed. Review it and
allow it again." If, after turning Email Routing on, your main domain gained or lost records other
than those, agent email stays off and the panel shows **What changed**: fix the records in
Cloudflare and select **Check again**, or tick the box to accept the records as they are now, then
select **Turn on agent email** again.

| The panel says                                                                                                     | What to do                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "The main domain has multiple SPF records…"                                                                        | Keep one SPF record on the main domain, merging the others into it                                                                                                 |
| "The main domain receives mail but has no SPF record…"                                                             | Add an SPF record that authorizes your current mail provider (not needed for Google Workspace)                                                                     |
| "The existing SPF policy cannot be safely verified automatically. Review its redirect and terminal all mechanism…" | Setup handles SPF records that end in `~all` or `-all` and don't use `redirect=`. Rewrite the record that way                                                      |
| "This SPF policy uses mechanisms that automatic setup cannot safely verify."                                       | Setup understands only `include:`, `ip4:`, `ip6:`, `all` and `exp=`. Replace `a`, `mx` or other mechanisms with the equivalent `ip4:`/`ip6:` addresses or includes |
| "The proposed SPF policy exceeds the 10 DNS lookup limit."                                                         | Remove includes you no longer need, so that your senders plus Cloudflare's stay within SPF's limit of 10 lookups                                                   |

## Check that it works (admins)

**Admin → Integrations → Agent email** shows whether agent email is on and its domain. Once it is
on, it can send a fixed loopback test: add `agent+loopback@agents.<your-domain>` to an automation's
**Allowed senders**, then send the test to that automation's address. Its agent starts, and when it
replies, the reply comes back to SAM and appears under **Last reply received**. The same is
available through [`/api/admin/agent-email`](/docs/reference/api/#agent-email-preview).

Cloudflare's Email Routing summary lists every reply an agent sends as **dropped**, even when it was
delivered. Check Email Sending's metrics and logs for replies instead.
