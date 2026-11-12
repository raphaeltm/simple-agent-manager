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
# With --kms, also the key that seals the box's Worker secrets (README, Sealed secrets):
#   - a Cloud KMS key ring (default sam-selfhost) and a key for this install (default
#     sam-<8 hex of sha256(issuer)>, the name `pnpm selfhost:deploy --init` looks for),
#   - roles/cloudkms.cryptoKeyEncrypterDecrypter for the box VM's service account on that key only,
# then prints the key reference.
#
# Every resource is described first and created only when missing; what this script created (not
# what it found) is written to <state-dir>/created-resources.json, which --teardown reads. A
# provider that already trusts a different issuer is never retargeted; pick another --pool-id.
#
# Usage:
#   pnpm selfhost:gcp-bootstrap -- --project <id> --api-url https://api.<domain> [--kms ...] [--dry-run]
#   pnpm selfhost:gcp-bootstrap -- --project <id> --api-url https://api.<domain> --teardown [--dry-run]
# Options:
#   --pool-id <id>          default: sam-<8 hex of sha256(issuer)>, unique per install
#   --provider-id <id>      default: sam-api
#   --service-account <id>  default: sam-nodes (account id, before @)
#   --skip-issuer-check     do not fetch <api-url>/.well-known/openid-configuration first
#   --kms                   also create the key for sealed secrets (needs a box identity below)
#   --kms-only              only the key: no pool, provider or node service account
#   --box-service-account <email>  the box VM's service account, granted use of the key
#   --box-instance <name> --box-zone <zone>  read that service account (and its scopes) from the VM
#   --kms-location <loc>    default: global
#   --key-ring <id>         default: sam-selfhost
#   --key <id>              default: sam-<8 hex of sha256(issuer)>
#   --state-dir <dir>       where created-resources.json lives; default: deploy/selfhost/.state
#   --teardown              remove what this script created for this install (see README)
#   --destroy-key-versions <key id>  with --teardown: schedule destruction of the key's versions.
#                           Every bundle and backup sealed with the key becomes unrecoverable.
#   --dry-run               print every gcloud command that would change something; change nothing
set -euo pipefail

PROJECT=""
API_URL=""
POOL_ID=""
PROVIDER_ID="sam-api"
SA_ID="sam-nodes"
DRY_RUN=0
CHECK_ISSUER=1
KMS=0
NODES=1
TEARDOWN=0
BOX_SA=""
BOX_INSTANCE=""
BOX_ZONE=""
KMS_LOCATION="global"
KEY_RING="sam-selfhost"
KEY_ID=""
DESTROY_KEY=""
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${HERE}/.state"
RECORD_TOOL="${HERE}/created-resources.mjs"
TOOL="gcp-bootstrap"

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
    --kms) KMS=1; shift ;;
    --kms-only) KMS=1; NODES=0; shift ;;
    --box-service-account) BOX_SA="${2:-}"; shift 2 ;;
    --box-instance) BOX_INSTANCE="${2:-}"; shift 2 ;;
    --box-zone) BOX_ZONE="${2:-}"; shift 2 ;;
    --kms-location) KMS_LOCATION="${2:-}"; shift 2 ;;
    --key-ring) KEY_RING="${2:-}"; shift 2 ;;
    --key) KEY_ID="${2:-}"; shift 2 ;;
    --state-dir) STATE_DIR="${2:-}"; shift 2 ;;
    --teardown) TEARDOWN=1; shift ;;
    --destroy-key-versions) DESTROY_KEY="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,47p' "$0"; exit 0 ;;
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
printf '%s' "$PROJECT" | grep -Eq '^[a-z][a-z0-9-]{4,28}[a-z0-9]$' || die "invalid --project: $PROJECT"

if command -v sha256sum >/dev/null 2>&1; then hash_cmd=(sha256sum); else hash_cmd=(shasum -a 256); fi
INSTALL_HASH="$(printf '%s' "$ISSUER" | "${hash_cmd[@]}" | cut -c1-8)"
[ -n "$POOL_ID" ] || POOL_ID="sam-${INSTALL_HASH}"
[ -n "$KEY_ID" ] || KEY_ID="sam-${INSTALL_HASH}"
printf '%s' "$POOL_ID" | grep -Eq '^[a-z][a-z0-9-]{3,31}$' || die "invalid --pool-id: $POOL_ID"
printf '%s' "$PROVIDER_ID" | grep -Eq '^[a-z][a-z0-9-]{3,31}$' || die "invalid --provider-id: $PROVIDER_ID"
printf '%s' "$SA_ID" | grep -Eq '^[a-z][a-z0-9-]{5,29}$' || die "invalid --service-account: $SA_ID"
printf '%s' "$KMS_LOCATION" | grep -Eq '^[a-z0-9-]{1,63}$' || die "invalid --kms-location: $KMS_LOCATION"
printf '%s' "$KEY_RING" | grep -Eq '^[A-Za-z0-9_-]{1,63}$' || die "invalid --key-ring: $KEY_RING"
printf '%s' "$KEY_ID" | grep -Eq '^[A-Za-z0-9_-]{1,63}$' || die "invalid --key: $KEY_ID"
[ -z "$DESTROY_KEY" ] || [ "$TEARDOWN" -eq 1 ] || die "--destroy-key-versions needs --teardown"

SA_EMAIL="${SA_ID}@${PROJECT}.iam.gserviceaccount.com"
CONDITION="assertion.iss == '${ISSUER}'"
POOL_NAME="projects/${PROJECT}/locations/global/workloadIdentityPools/${POOL_ID}"
KEY_NAME="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KEY_RING}/cryptoKeys/${KEY_ID}"
RING_NAME="projects/${PROJECT}/locations/${KMS_LOCATION}/keyRings/${KEY_RING}"
KMS_ROLE="roles/cloudkms.cryptoKeyEncrypterDecrypter"
RECORD="${STATE_DIR}/created-resources.json"
KEY_FLAGS=(--keyring="$KEY_RING" --location="$KMS_LOCATION" --project="$PROJECT")

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
# record <kind> <name> <created|reused> [k=v ...]: no-op in a dry run.
record() {
  [ "$DRY_RUN" -eq 1 ] && return 0
  node "$RECORD_TOOL" add "$RECORD" gcp "$1" "$2" "$3" "$TOOL" "project=${PROJECT}" "install=${ISSUER}" "${@:4}"
}
# Whether the record says this script created <kind> <name> (and no teardown removed it yet).
created() {
  [ -f "$RECORD" ] || return 1
  node "$RECORD_TOOL" list "$RECORD" gcp "$TOOL" | awk -F'\t' -v k="$1" -v n="$2" \
    '$1 == k && $2 == n && $3 == "created" && $4 == "" { found = 1 } END { exit found ? 0 : 1 }'
}

command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed or not on PATH"
command -v node >/dev/null 2>&1 || die "node is not on PATH (it writes the created-resources record)"

if [ "$TEARDOWN" -eq 1 ]; then
  # shellcheck source=deploy/selfhost/gcp-teardown.sh
  . "${HERE}/gcp-teardown.sh"
  run_teardown
  exit 0
fi

if [ "$CHECK_ISSUER" -eq 1 ]; then
  discovery="$(curl -fsS --max-time 10 "${ISSUER}/.well-known/openid-configuration" 2>/dev/null)" \
    || die "could not read ${ISSUER}/.well-known/openid-configuration (is the install up? --skip-issuer-check to skip)"
  issuer_re="$(printf '%s' "$ISSUER" | sed 's/[.]/\\./g')"
  printf '%s' "$discovery" | grep -Eq "\"issuer\"[[:space:]]*:[[:space:]]*\"${issuer_re}\"" \
    || die "the install at ${ISSUER} does not advertise issuer ${ISSUER}; check --api-url"
fi

if [ "$KMS" -eq 1 ]; then
  if [ -n "$BOX_INSTANCE" ]; then
    [ -n "$BOX_ZONE" ] || die "--box-instance needs --box-zone"
    BOX_SA="$(gcloud compute instances describe "$BOX_INSTANCE" --zone="$BOX_ZONE" --project="$PROJECT" \
      --format='value(serviceAccounts[0].email)')" || die "cannot read instance ${BOX_INSTANCE}"
    scopes="$(gcloud compute instances describe "$BOX_INSTANCE" --zone="$BOX_ZONE" --project="$PROJECT" \
      --format='value(serviceAccounts[0].scopes)')"
    case "$scopes" in
      *cloud-platform*|*cloudkms*) ;;
      *) echo "WARNING: ${BOX_INSTANCE}'s access scopes allow neither cloud-platform nor cloudkms;" \
           "Cloud KMS will refuse the VM's token until the scopes include one (instance stopped):" \
           "gcloud compute instances set-service-account ${BOX_INSTANCE} --zone=${BOX_ZONE} --service-account=${BOX_SA} --scopes=cloud-platform" >&2 ;;
    esac
  fi
  [ -n "$BOX_SA" ] || die "--kms needs the box VM's identity: --box-service-account <email> or --box-instance <name> --box-zone <zone>"
  printf '%s' "$BOX_SA" | grep -Eq '^[a-z0-9-]+@[a-z0-9.-]+\.gserviceaccount\.com$' \
    || die "invalid box service account: $BOX_SA"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null)" \
  || die "cannot read project ${PROJECT}; run 'gcloud auth login' as a project owner"
[ -n "$PROJECT_NUMBER" ] || die "project ${PROJECT} has no project number"

echo "Project ${PROJECT} (${PROJECT_NUMBER}), issuer ${ISSUER}, pool ${POOL_ID}"

if [ "$NODES" -eq 1 ]; then
  change services enable compute.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
    sts.googleapis.com --project="$PROJECT"

  if exists iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT" --location=global; then
    echo "pool ${POOL_ID}: exists"
    record workload-identity-pool "$POOL_NAME" reused
  else
    change iam workload-identity-pools create "$POOL_ID" --project="$PROJECT" --location=global \
      --display-name="SAM ${ISSUER#https://api.}" \
      --description="Dedicated to the SAM install whose token issuer is ${ISSUER}"
    record workload-identity-pool "$POOL_NAME" created
  fi

  if exists iam workload-identity-pools providers describe "$PROVIDER_ID" --project="$PROJECT" \
    --location=global --workload-identity-pool="$POOL_ID"; then
    current="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
      --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
      --format='value(oidc.issuerUri)')"
    [ "$current" = "$ISSUER" ] \
      || die "provider ${POOL_ID}/${PROVIDER_ID} already trusts ${current}, not ${ISSUER}; refusing to retarget it. Use another --pool-id."
    echo "provider ${PROVIDER_ID}: exists, issuer ${ISSUER}"
    record workload-identity-provider "${POOL_NAME}/providers/${PROVIDER_ID}" reused
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
    record workload-identity-provider "${POOL_NAME}/providers/${PROVIDER_ID}" created
  fi

  sa_action=reused
  if exists iam service-accounts describe "$SA_EMAIL" --project="$PROJECT"; then
    echo "service account ${SA_EMAIL}: exists"
    created service-account "$SA_EMAIL" && sa_action=created
  else
    # The description names the issuer: --teardown deletes only an account that carries it.
    change iam service-accounts create "$SA_ID" --project="$PROJECT" --display-name="SAM nodes" \
      --description="Creates and deletes SAM workspace VMs and their firewall rules for ${ISSUER}"
    sa_action=created
  fi
  record service-account "$SA_EMAIL" "$sa_action"

  for role in roles/compute.instanceAdmin.v1 roles/compute.securityAdmin; do
    change_retry projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA_EMAIL}" \
      --role="$role" --condition=None --quiet --format=none
    # Ours to remove only with the account ours too: a shared account keeps its roles.
    record iam-binding "projects/${PROJECT}#${role}#serviceAccount:${SA_EMAIL}" "$sa_action" \
      "resource=projects/${PROJECT}" "role=${role}" "member=serviceAccount:${SA_EMAIL}"
  done

  # Scope: the whole pool. That is this one install only, because the pool is created for it and
  # its only provider admits tokens whose issuer is this install's API origin (the condition
  # above, checked again on every run). Any provider added to this pool later would inherit the
  # service account, so do not add providers to it.
  change_retry iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project="$PROJECT" \
    --role=roles/iam.workloadIdentityUser \
    --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/*" \
    --condition=None --quiet --format=none
fi

if [ "$KMS" -eq 1 ]; then
  change services enable cloudkms.googleapis.com --project="$PROJECT"
  if exists kms keyrings describe "$KEY_RING" --location="$KMS_LOCATION" --project="$PROJECT"; then
    echo "key ring ${KEY_RING}: exists"
    created kms-key-ring "$RING_NAME" || record kms-key-ring "$RING_NAME" reused
  else
    change kms keyrings create "$KEY_RING" --location="$KMS_LOCATION" --project="$PROJECT"
    record kms-key-ring "$RING_NAME" created
  fi
  if exists kms keys describe "$KEY_ID" "${KEY_FLAGS[@]}"; then
    owner="$(gcloud kms keys describe "$KEY_ID" "${KEY_FLAGS[@]}" --format='value(labels.sam-install)')"
    [ "$owner" = "$INSTALL_HASH" ] \
      || die "key ${KEY_NAME} exists but is not labelled sam-install=${INSTALL_HASH}; refusing to use another install's key. Pick --key."
    echo "key ${KEY_ID}: exists"
    created kms-key "$KEY_NAME" || record kms-key "$KEY_NAME" reused
  else
    # Labelled with this install, so --teardown can prove the key is this install's.
    change kms keys create "$KEY_ID" "${KEY_FLAGS[@]}" --purpose=encryption \
      --labels="sam-install=${INSTALL_HASH}"
    record kms-key "$KEY_NAME" created
  fi
  # On the key only, never the ring or the project.
  change_retry kms keys add-iam-policy-binding "$KEY_ID" "${KEY_FLAGS[@]}" \
    --member="serviceAccount:${BOX_SA}" --role="$KMS_ROLE" --format=none
  record iam-binding "${KEY_NAME}#${KMS_ROLE}#serviceAccount:${BOX_SA}" created \
    "resource=${KEY_NAME}" "role=${KMS_ROLE}" "member=serviceAccount:${BOX_SA}"
fi

[ "$DRY_RUN" -eq 1 ] && echo "Dry run: nothing was changed."
if [ "$NODES" -eq 1 ]; then
  cat <<EOF

Enter these in Admin -> Integrations -> Google Cloud:
  Project ID:             ${PROJECT}
  Project number:         ${PROJECT_NUMBER}
  Pool ID:                ${POOL_ID}
  Provider ID:            ${PROVIDER_ID}
  Service account email:  ${SA_EMAIL}
EOF
fi
if [ "$KMS" -eq 1 ]; then
  cat <<EOF

Sealed-secrets key (the box VM ${BOX_SA} may encrypt and decrypt with it, nothing else):
  SAM_GCP_KMS_KEY=${KEY_NAME}
With the default names, \`pnpm selfhost:deploy --init\` on the box finds it by itself; otherwise
put that line in deploy/selfhost/.env. A box already sealed with another key moves to it with
\`pnpm selfhost:secrets switch --to gcp-kms\`.
EOF
fi
[ "$DRY_RUN" -eq 1 ] || echo "Recorded what this created in ${RECORD} (--teardown reads it)."
