---
title: Connect Google Cloud
description: GCP infrastructure OAuth, API prerequisites, Workload Identity Federation, and connection troubleshooting.
---

Connect Google Cloud in **Settings → Infrastructure → Cloud accounts → Connect account** to run SAM nodes in your own GCP project. Choose **Connect with Google** for keyless Workload Identity Federation (WIF), or use a service-account JSON key when infrastructure OAuth is unavailable. This guide covers the WIF setup and errors you may encounter before any VM is created.

## Keep the two projects separate

Your **OAuth-client project** owns the Google OAuth application configured by the SAM installation administrator. Your **VM project** is the project you select when connecting your cloud account; it owns the WIF resources, service account, and VMs. These can be different projects, including projects in different organizations, subject to your access and organization policies.

API enablement is per project. Enabling an API in the VM project does not necessarily enable requests made using the OAuth client's project. Google calls these the client and resource projects; see [Google Cloud API setup](https://cloud.google.com/apis/docs/getting-started).

## Installation administrator: prepare infrastructure OAuth

1. Create a Google OAuth web application for infrastructure authorization. Register `https://api.yourdomain.com/auth/google/callback` as its authorized redirect URI, replacing `yourdomain.com` with your SAM domain.
2. Configure its client ID and secret in **Admin → Integrations → Google infrastructure OAuth**. This is separate from Google **login** OAuth, whose callback is `/api/auth/callback/google`. Runtime integration settings take precedence over the `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment fallbacks, without a redeploy.
3. In the Google Cloud Console, select the project that owns this infrastructure OAuth client. Open **APIs & Services → Library** and enable **Cloud Resource Manager API** (`cloudresourcemanager.googleapis.com`) and **Identity and Access Management (IAM) API** (`iam.googleapis.com`). Both have caused setup failures when absent from a newly configured OAuth-client project.
4. Configure the OAuth audience and consent settings for the people who will connect accounts. SAM requests the `https://www.googleapis.com/auth/cloud-platform` scope. If you move to a client in another project, check that project's API enablement again; the old project's settings do not move with the client.

Being a Google Workspace administrator does not make a disabled API available. Check API enablement separately from the signed-in account's GCP IAM permissions.

## Connect the VM project

1. Choose **Connect with Google** and authorize the Google account that has access to your intended VM project.
2. Select the GCP project and a **Default Zone**, then click **Connect with WIF**.
3. SAM enables the target project's APIs, creates or reuses its WIF pool/provider and service account, grants the required bindings, saves the connection, and attempts to verify token exchange. Newly created Google resources can take time to propagate; a saved connection can therefore report that verification is not yet complete.

The setup identity needs permission to enable services, manage WIF pools/providers and service accounts, and update the project's IAM policy. Google documents the WIF administration prerequisites in its [Workload Identity Federation guide](https://cloud.google.com/iam/docs/workload-identity-federation-with-other-providers). Organization policies can still restrict setup; investigate the specific Google error before adding broad IAM roles.

SAM's VM setup requests these APIs in the **selected VM project**: Cloud Resource Manager, IAM, IAM Service Account Credentials (`iamcredentials.googleapis.com`), Security Token Service (`sts.googleapis.com`), Compute Engine (`compute.googleapis.com`), Vertex AI (`aiplatform.googleapis.com`), and Cloud Billing (`cloudbilling.googleapis.com`, read-only, for list prices). It calls Service Usage (`serviceusage.googleapis.com`) to enable them. This target-project setup does not replace the OAuth-client project prerequisites above.

The default zone is a connection setting, not a restriction on all node-pool offerings. Review the allowed machine types and regions in your [compute pool](/docs/guides/compute-pools/) to control where SAM may place work.

SAM accepts any Compute Engine zone name, including zones Google adds later. The zone picker suggests common zones, but it is not the full list. When SAM looks for its own VMs (orphan cleanup, allocation recovery), it lists every zone in the project in one call. If Google reports any zone as unreachable, SAM treats the list as incomplete: cleanup skips that run and tries again on the next one, and a recovery check fails rather than assuming a VM is gone.

## Machine types, zones and prices

SAM reads the Google Cloud machine catalog live; nothing about zones or prices is fixed in SAM.

- **Machine types.** SAM offers the types named in the admin setting `gcpCatalog.machineTypes`
  (by default e2-medium plus the standard e2, n2d and t2d types up to 16 vCPUs). For each one it
  lists every zone where your project can create it, using the connection's own credentials.
  Arm (ARM64) types such as t2a are skipped, because SAM boots Google Cloud nodes from an amd64
  image.
- **Prices.** SAM reads Google's public Compute Engine list prices (USD, on demand) from the Cloud
  Billing Catalog API and prices each machine as its vCPUs times the core price plus its memory
  times the RAM price for that region. Prices are the same for every Google project, so SAM keeps
  one price list for the whole installation and refreshes it about once a day in the background,
  using any connected Google Cloud credential (platform credentials first) with a token limited to
  read-only Cloud Billing access. The price excludes the boot disk.
- **Price unavailable.** If no connected project has the Cloud Billing API enabled, or Google has no
  list price SAM recognises for a machine in a region, the machine is still offered but shows
  "Price unavailable". SAM never guesses a price. Enable `cloudbilling.googleapis.com` in the
  connected project to fix it; the next refresh picks it up within the retry interval
  (`gcpCatalog.priceRetryMinutes`). Each retry tries the next connected credentials in turn, so
  credentials without the API cannot keep a working one from being tried. A refresh where every
  credential fails notifies operators as a failed scheduled sweep, and the previous price list is
  kept. So is a refresh that returns no usable price.
- **Credits and discounts are not reflected.** These are list prices. Committed-use discounts,
  free-tier usage and promotional credits apply on your Google invoice, not in SAM's ranking.

If Google reports a zone as unreachable while SAM reads the catalog, SAM treats that read as
incomplete: pools keep the machines they already had rather than marking that zone sold out. A
catalog response that does not list any zones is treated the same way.

## Troubleshoot connection errors

### Project listing fails with “Permission denied”

You may see:

> Failed to list Google Cloud projects. Permission denied. Please ensure your Google account has the required permissions on this project.

This message can mean the **Cloud Resource Manager API is disabled**, even when your account has administrative access. Ask your installation operator to inspect the underlying Google response as described below. If the reason is `SERVICE_DISABLED` and the service is `cloudresourcemanager.googleapis.com`, enable Cloud Resource Manager in the **consumer project identified by Google**, wait a few minutes, then retry.

### Connect with WIF says “Ensure your account has the IAM Admin role”

You may see:

> Failed to configure workload identity. Ensure your account has the IAM Admin role. Permission denied. Please ensure your Google account has the required permissions on this project.

This can also be `SERVICE_DISABLED`, this time for `iam.googleapis.com` in the OAuth-client project. Enable the **Identity and Access Management (IAM) API** in the project identified in Google's response, wait a few minutes, then retry **Connect with WIF**. Changing the default zone, such as Frankfurt, does not resolve a disabled IAM API.

If the API is already enabled, check the response reason and named permission or organization constraint. A generic HTTP 403 alone does not establish which IAM role is missing. If Google authorization expires while you troubleshoot, start **Connect with Google** again.

### Operators: find the underlying Google error

In your production API Worker's **Cloudflare Workers Logs**, search for `gcp_api_error` around the failed attempt. Match the environment and time rather than relying on the UI's generic permission text. The server event includes:

- `step`, such as `list_projects` or `create_wif_pool`;
- Google's HTTP status and structured response in `rawBody`;
- `error.details[].reason`, such as `SERVICE_DISABLED`;
- the affected `service`, `consumer` project number, and `activationUrl` in the error metadata.

For `SERVICE_DISABLED`, open Google's activation link, confirm the selected project and API, and enable it. A project **number** in this response is distinct from the readable project **ID**; verify the mapping in Google Cloud Console. Only share the minimal diagnostic reason and affected service/project with your administrator. Do not publish raw logs, access tokens, or credential values.

SAM currently maps Google 403 responses to generic permission advice, including disabled-API responses. The two messages above therefore do not, by themselves, prove that your account needs more permissions.

### Google Cloud appears twice in the node pool

Two headings such as **Google Cloud · Infrastructure settings** and **Google Cloud · Infrastructure settings (2)** can represent different connections. Older SAM versions can also show one GCP connection twice with identical machine offerings because they count its old and new credential-store copies as separate pool sources. Current versions recognize these managed copies as one connection.

The repeated list is not evidence that two sets of VMs were created. After upgrading, SAM reconciles existing duplicate sources when the pool is refreshed, preserving allowed matching offerings and historical references used by running work. Distinct connections stay separate. If entries still repeat, ask your operator to inspect them: unmatched custom offerings or concurrent edits can defer automatic repair to avoid losing your selections. Do not disconnect accounts or delete WIF resources solely to remove a repeated heading. This issue is unrelated to Google API enablement or the selected default zone.
