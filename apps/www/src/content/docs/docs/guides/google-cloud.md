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

SAM's VM setup requests these APIs in the **selected VM project**: Cloud Resource Manager, IAM, IAM Service Account Credentials (`iamcredentials.googleapis.com`), Security Token Service (`sts.googleapis.com`), Compute Engine (`compute.googleapis.com`), and Vertex AI (`aiplatform.googleapis.com`). It calls Service Usage (`serviceusage.googleapis.com`) to enable them. This target-project setup does not replace the OAuth-client project prerequisites above.

The default zone is a connection setting, not a restriction on all node-pool offerings. Review the allowed machine types and regions in your [compute pool](/docs/guides/compute-pools/) to control where SAM may place work.

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
