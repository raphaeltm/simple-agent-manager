/**
 * Google Cloud APIs SAM needs enabled in a connected VM project.
 *
 * Workload Identity setup (`runGcpSetup`) enables exactly this list with the user's own OAuth
 * token and records it on the credential as `enabledApis`. SAM's runtime service account cannot
 * enable APIs, so when this list grows, credentials set up earlier are missing the new entries
 * until their owner re-runs setup or enables the API in Google Cloud.
 */
export interface GcpRequiredApi {
  /** Service name, for example `cloudbilling.googleapis.com`. */
  service: string;
  /** Short name shown to users. */
  label: string;
}

export const GCP_REQUIRED_APIS: readonly GcpRequiredApi[] = [
  { service: 'cloudresourcemanager.googleapis.com', label: 'Cloud Resource Manager' },
  { service: 'iam.googleapis.com', label: 'Identity and Access Management' },
  { service: 'iamcredentials.googleapis.com', label: 'IAM Service Account Credentials' },
  { service: 'sts.googleapis.com', label: 'Security Token Service' },
  { service: 'compute.googleapis.com', label: 'Compute Engine' },
  { service: 'aiplatform.googleapis.com', label: 'Vertex AI' },
  // Live Compute Engine list prices for the node-pool catalog (`gcp-price-table.ts`).
  { service: 'cloudbilling.googleapis.com', label: 'Cloud Billing' },
];

/**
 * What setup enabled before credentials recorded `enabledApis` (everything above except Cloud
 * Billing, which #2572 added). A credential without the record is assumed to have exactly these.
 */
export const GCP_APIS_ENABLED_BEFORE_TRACKING: readonly string[] = [
  'cloudresourcemanager.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'compute.googleapis.com',
  'aiplatform.googleapis.com',
];

/** Cloud Billing, used read-only for Google's public Compute Engine list prices. */
export const GCP_CLOUD_BILLING_SERVICE = 'cloudbilling.googleapis.com';

/** Google Cloud console API library page; append `/<service>?project=<projectId>`. */
export const GCP_CONSOLE_API_LIBRARY_URL = 'https://console.cloud.google.com/apis/library';

/** Google project ids: 6-30 lowercase letters, digits and hyphens (plus legacy `domain:` ids). */
export const GCP_PROJECT_ID_PATTERN = /^(?:[a-z][a-z0-9.-]*:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** A Google service name as Google reports it (`<name>.googleapis.com`). */
export const GCP_SERVICE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.googleapis\.com$/;

/** The user-facing label for a Google service name, falling back to the name itself. */
export function gcpApiLabel(service: string): string {
  return GCP_REQUIRED_APIS.find((api) => api.service === service)?.label ?? service;
}

/**
 * Console link that opens the enable page for `service` in `gcpProjectId`, or null when `service`
 * is not a Google service name (the link is built from stored data, so it checks for itself).
 */
export function gcpEnableApiUrl(service: string, gcpProjectId: string): string | null {
  if (!GCP_SERVICE_NAME_PATTERN.test(service)) return null;
  return `${GCP_CONSOLE_API_LIBRARY_URL}/${encodeURIComponent(service)}?project=${encodeURIComponent(gcpProjectId)}`;
}
