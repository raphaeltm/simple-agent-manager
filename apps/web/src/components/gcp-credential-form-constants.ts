/** Static choices and copy for `GcpCredentialForm`. */
export const GCP_ZONES = [
  { id: 'us-central1-a', label: 'Iowa (us-central1-a)' },
  { id: 'us-east1-b', label: 'South Carolina (us-east1-b)' },
  { id: 'us-west1-a', label: 'Oregon (us-west1-a)' },
  { id: 'europe-west1-b', label: 'Belgium (europe-west1-b)' },
  { id: 'europe-west3-a', label: 'Frankfurt (europe-west3-a)' },
  { id: 'europe-west2-a', label: 'London (europe-west2-a)' },
  { id: 'asia-southeast1-a', label: 'Singapore (asia-southeast1-a)' },
  { id: 'asia-northeast1-a', label: 'Tokyo (asia-northeast1-a)' },
];

export const SETUP_STEPS = [
  { key: 'get_project_number', label: 'Getting project info' },
  { key: 'enable_apis', label: 'Enabling required APIs' },
  { key: 'create_wif_pool', label: 'Creating identity pool' },
  { key: 'create_oidc_provider', label: 'Configuring OIDC provider' },
  { key: 'create_service_account', label: 'Creating service account' },
  { key: 'grant_wif_user', label: 'Setting permissions' },
  { key: 'grant_project_roles', label: 'Granting compute access' },
];

export const SERVICE_ACCOUNT_COMMANDS = `PROJECT_ID="your-gcp-project-id"
SERVICE_ACCOUNT="sam-vm-manager@\${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable compute.googleapis.com cloudbilling.googleapis.com --project="\${PROJECT_ID}"
gcloud iam service-accounts create sam-vm-manager --project="\${PROJECT_ID}" --display-name="SAM VM manager"
gcloud projects add-iam-policy-binding "\${PROJECT_ID}" --member="serviceAccount:\${SERVICE_ACCOUNT}" --role="roles/compute.instanceAdmin.v1"
gcloud projects add-iam-policy-binding "\${PROJECT_ID}" --member="serviceAccount:\${SERVICE_ACCOUNT}" --role="roles/compute.securityAdmin"
gcloud iam service-accounts keys create sam-service-account.json --iam-account="\${SERVICE_ACCOUNT}" --project="\${PROJECT_ID}"`;
