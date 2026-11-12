#!/usr/bin/env bash
# One-command Google Cloud trust for a self-hosted SAM install (pnpm selfhost:gcp-bootstrap).
#
# Creates or reuses, in one GCP project:
#   - a workload identity pool dedicated to this install,
#   - an OIDC provider in it that trusts only this install's token issuer
#     (https://api.<domain>, the `iss` SAM signs with: getIssuer() in apps/api/src/services/jwt.ts),
#   - a node service account with roles/compute.instanceAdmin.v1 and roles/compute.securityAdmin,
#   - the binding that lets identities from that pool impersonate the service account,
# then prints the five values Admin -> Integrations -> Google Cloud asks for.
#
# Idempotent: every resource is described first and created only when missing. A provider that
# already trusts a different issuer is never retargeted; pick another --pool-id instead.
#
# Usage:
#   pnpm selfhost:gcp-bootstrap -- --project <gcp-project-id> --api-url https://api.<domain> [--dry-run]
# Options:
#   --pool-id <id>          default: sam-<8 hex of sha256(issuer)>, unique per install
#   --provider-id <id>      default: sam-api
#   --service-account <id>  default: sam-nodes (account id, before @)
#   --skip-issuer-check     do not fetch <api-url>/.well-known/openid-configuration first
#   --dry-run               print every gcloud command that would change something; change nothing
set -euo pipefail

PROJECT=""
API_URL=""
POOL_ID=""
PROVIDER_ID="sam-api"
SA_ID="sam-nodes"
DRY_RUN=0
CHECK_ISSUER=1

die() { echo "gcp-bootstrap: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --) shift ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --api-url) API_URL="${2:-}"; shift 2 ;;
    --pool-id) POOL_ID="${2:-}"; shift 2 ;;
    --provider-id) PROVIDER_ID="${2:-}"; shift 2 ;;
    --service-account) SA_ID="${2:-}"; shift 2 ;;
    --skip-issuer-check) CHECK_ISSUER=0; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

[ -n "$PROJECT" ] || die "--project is required"
[ -n "$API_URL" ] || die "--api-url is required (https://api.<your SAM domain>)"
ISSUER="${API_URL%/}"
case "$ISSUER" in
  https://api.*) ;;
  *) die "--api-url must be https://api.<domain> (the issuer SAM signs tokens with), got: $API_URL" ;;
esac
# The issuer is interpolated into a CEL condition: allow only URL-safe characters.
printf '%s' "$ISSUER" | grep -Eq '^https://[A-Za-z0-9.-]+(:[0-9]+)?$' \
  || die "--api-url must be a bare origin such as https://api.example.com, got: $API_URL"

if [ -z "$POOL_ID" ]; then
  if command -v sha256sum >/dev/null 2>&1; then hash_cmd=(sha256sum); else hash_cmd=(shasum -a 256); fi
  POOL_ID="sam-$(printf '%s' "$ISSUER" | "${hash_cmd[@]}" | cut -c1-8)"
fi
printf '%s' "$POOL_ID" | grep -Eq '^[a-z][a-z0-9-]{3,31}$' || die "invalid --pool-id: $POOL_ID"
printf '%s' "$PROVIDER_ID" | grep -Eq '^[a-z][a-z0-9-]{3,31}$' || die "invalid --provider-id: $PROVIDER_ID"
printf '%s' "$SA_ID" | grep -Eq '^[a-z][a-z0-9-]{5,29}$' || die "invalid --service-account: $SA_ID"

SA_EMAIL="${SA_ID}@${PROJECT}.iam.gserviceaccount.com"
CONDITION="assertion.iss == '${ISSUER}'"

# Read-only calls run in every mode; changes go through `change`.
change() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'would run: gcloud'; printf ' %q' "$@"; printf '\n'
  else
    gcloud "$@"
  fi
}
exists() { gcloud "$@" >/dev/null 2>&1; }
# IAM bindings on a just-created service account can fail until it propagates: retry briefly.
change_retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    change "$@" && return 0
    [ "$attempt" -lt 5 ] && sleep "${GCP_BOOTSTRAP_RETRY_SECONDS:-5}"
  done
  return 1
}

command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed or not on PATH"

if [ "$CHECK_ISSUER" -eq 1 ]; then
  discovery="$(curl -fsS --max-time 10 "${ISSUER}/.well-known/openid-configuration" 2>/dev/null)" \
    || die "could not read ${ISSUER}/.well-known/openid-configuration (is the install up? --skip-issuer-check to skip)"
  issuer_re="$(printf '%s' "$ISSUER" | sed 's/[.]/\\./g')"
  printf '%s' "$discovery" | grep -Eq "\"issuer\"[[:space:]]*:[[:space:]]*\"${issuer_re}\"" \
    || die "the install at ${ISSUER} does not advertise issuer ${ISSUER}; check --api-url"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null)" \
  || die "cannot read project ${PROJECT}; run 'gcloud auth login' as a project owner"
[ -n "$PROJECT_NUMBER" ] || die "project ${PROJECT} has no project number"

echo "Project ${PROJECT} (${PROJECT_NUMBER}), issuer ${ISSUER}, pool ${POOL_ID}"

change services enable compute.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com --project="$PROJECT"

if exists iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT" --location=global; then
  echo "pool ${POOL_ID}: exists"
else
  change iam workload-identity-pools create "$POOL_ID" --project="$PROJECT" --location=global \
    --display-name="SAM ${ISSUER#https://api.}" \
    --description="Dedicated to the SAM install whose token issuer is ${ISSUER}"
fi

if exists iam workload-identity-pools providers describe "$PROVIDER_ID" --project="$PROJECT" \
  --location=global --workload-identity-pool="$POOL_ID"; then
  current="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
    --format='value(oidc.issuerUri)')"
  [ "$current" = "$ISSUER" ] \
    || die "provider ${POOL_ID}/${PROVIDER_ID} already trusts ${current}, not ${ISSUER}; refusing to retarget it. Use another --pool-id."
  echo "provider ${PROVIDER_ID}: exists, issuer ${ISSUER}"
else
  # Only this install's issuer is admitted (attributeCondition), and only tokens addressed to
  # this provider: SAM signs aud=https://iam.googleapis.com/<provider> (gcp-sts.ts). Mapping
  # matches the guided setup (gcp-setup.ts).
  change iam workload-identity-pools providers create-oidc "$PROVIDER_ID" --project="$PROJECT" \
    --location=global --workload-identity-pool="$POOL_ID" --display-name="SAM API" \
    --issuer-uri="$ISSUER" \
    --allowed-audiences="https://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}" \
    --attribute-mapping="google.subject=assertion.sub,attribute.sam_user=assertion.user_id,attribute.sam_project=assertion.project_id" \
    --attribute-condition="$CONDITION"
fi

if exists iam service-accounts describe "$SA_EMAIL" --project="$PROJECT"; then
  echo "service account ${SA_EMAIL}: exists"
else
  change iam service-accounts create "$SA_ID" --project="$PROJECT" --display-name="SAM nodes" \
    --description="Creates and deletes SAM workspace VMs and their firewall rules"
fi

for role in roles/compute.instanceAdmin.v1 roles/compute.securityAdmin; do
  change_retry projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA_EMAIL}" \
    --role="$role" --condition=None --quiet --format=none
done

# Scope: the whole pool. That is this one install only, because the pool is created for it and
# its only provider admits tokens whose issuer is this install's API origin (the condition
# above, checked again on every run). Any provider added to this pool later would inherit the
# service account, so do not add providers to it.
change_retry iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project="$PROJECT" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/*" \
  --condition=None --quiet --format=none

[ "$DRY_RUN" -eq 1 ] && echo "Dry run: nothing was changed."
cat <<EOF

Enter these in Admin -> Integrations -> Google Cloud:
  Project ID:             ${PROJECT}
  Project number:         ${PROJECT_NUMBER}
  Pool ID:                ${POOL_ID}
  Provider ID:            ${PROVIDER_ID}
  Service account email:  ${SA_EMAIL}
EOF
