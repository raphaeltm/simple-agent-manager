#!/usr/bin/env bash
# One-command Google Cloud trust for nodes of a self-hosted SAM install (pnpm selfhost:gcp-bootstrap).
# EXPERIMENTAL, like the rest of deploy/selfhost (README.md).
#
# Creates or reuses, in one GCP project:
#   - a workload identity pool dedicated to this install,
#   - an OIDC provider in it that trusts only this install's token issuer
#     (https://api.<domain>, the `iss` SAM signs with: getIssuer() in apps/api/src/services/jwt.ts),
#   - a node service account with roles/compute.instanceAdmin.v1 and roles/compute.securityAdmin,
#   - the binding that lets identities from that pool impersonate the service account,
#   - the APIs nodes need, including Cloud Billing (read-only list prices for the machine catalog),
# then prints the platform cloud credential to add in Admin -> Credentials (Cloud Provider, GCP).
# It does not create the box VM, its firewall, the fleet bucket or DNS (README.md, Prerequisites).
#
# Use a GCP project dedicated to SAM's nodes, not the box's project: the service account's roles
# apply to the whole project, so in a shared project it could also change or delete the box VM
# and its firewall rules.
#
# Every resource is described first and created only when missing. A provider that already
# trusts a different issuer is never retargeted, and an existing pool is reused only when its
# sole provider is this install's (the pool-wide binding below admits every provider in it);
# otherwise pick another --pool-id.
#
# Run it once the install answers (after the first `pnpm selfhost:deploy`): it checks the issuer
# the install advertises.
#
# Usage:
#   pnpm selfhost:gcp-bootstrap -- --project <id> --api-url https://api.<domain> [--dry-run]
# Options:
#   --pool-id <id>          default: sam-<8 hex of sha256(issuer)>, unique per install
#   --provider-id <id>      default: sam-api
#   --service-account <id>  default: sam-nodes (account id, before @)
#   --skip-issuer-check     do not fetch <api-url>/.well-known/openid-configuration first
#   --state-dir <dir>       creation receipts (default deploy/selfhost/.state)
#   --installation-id <id>  normalized SAM_INSTALLATION_ID; enables ownership receipts for teardown
#   --create-firewalls      create absent shared SAM node rules with installation ownership metadata
#   --agent-source-ranges <CIDRs>  required with --create-firewalls (comma-separated; agent ingress)
#   --dry-run               print every gcloud command that would change something; change nothing
set -euo pipefail

PROJECT=""
API_URL=""
POOL_ID=""
PROVIDER_ID="sam-api"
SA_ID="sam-nodes"
DRY_RUN=0
CHECK_ISSUER=1
INSTALLATION_ID=""
CREATE_FIREWALLS=0
AGENT_RANGES=""
STATE_DIR="$(cd "$(dirname "$0")" && pwd)/.state"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# The APIs node provisioning calls: compute (VMs, firewalls; packages/providers/src/gcp*.ts),
# cloudbilling (list prices, gcp-pricing.ts), and iam, sts and iamcredentials (the pool and the
# token exchange and impersonation in apps/api/src/services/gcp-sts.ts). The in-app guided setup
# enables GCP_REQUIRED_APIS (packages/shared/src/constants/gcp-required-apis.ts); two of those
# are intentionally left out here, because no node path calls them:
#   cloudresourcemanager.googleapis.com: only the guided setup (gcp-setup.ts) calls it, with the
#     user's own OAuth token, to list projects and edit the project IAM policy.
#   aiplatform.googleapis.com: Vertex AI for agents in a user's own project, not node provisioning.
# Likewise the guided setup also grants roles/aiplatform.user (SA_PROJECT_ROLES in gcp-setup.ts);
# the node service account gets only the two compute roles.
# scripts/selfhost/gcp-bootstrap.test.ts fails when either list drifts from the guided setup's.
NODE_APIS=(compute.googleapis.com iam.googleapis.com iamcredentials.googleapis.com
  sts.googleapis.com cloudbilling.googleapis.com)
NODE_ROLES=(roles/compute.instanceAdmin.v1 roles/compute.securityAdmin)

die() { echo "gcp-bootstrap: $*" >&2; exit 1; }
# `--flag value`: refuse a trailing flag with no value instead of failing on `shift 2`.
need_value() { [[ "$2" -ge 2 ]] || die "$1 needs a value (see --help)"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --project) need_value "$1" $#; PROJECT="$2"; shift 2 ;;
    --api-url) need_value "$1" $#; API_URL="$2"; shift 2 ;;
    --pool-id) need_value "$1" $#; POOL_ID="$2"; shift 2 ;;
    --provider-id) need_value "$1" $#; PROVIDER_ID="$2"; shift 2 ;;
    --service-account) need_value "$1" $#; SA_ID="$2"; shift 2 ;;
    --skip-issuer-check) CHECK_ISSUER=0; shift ;;
    --installation-id) need_value "$1" $#; INSTALLATION_ID="$2"; shift 2 ;;
    --create-firewalls) CREATE_FIREWALLS=1; shift ;;
    --agent-source-ranges) need_value "$1" $#; AGENT_RANGES="$2"; shift 2 ;;
    --state-dir) need_value "$1" $#; STATE_DIR="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    # The header comment, up to the first line that is not a comment.
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done

# grep checks below are line by line: refuse any value with a newline before they run.
for value in "$PROJECT" "$API_URL" "$POOL_ID" "$PROVIDER_ID" "$SA_ID" "$INSTALLATION_ID" "$AGENT_RANGES"; do
  case "$value" in
    *$'\n'*|*$'\r'*) die "arguments must not contain line breaks" ;;
    *) ;;
  esac
done
[[ -n "$PROJECT" ]] || die "--project is required"
[[ -n "$API_URL" ]] || die "--api-url is required (https://api.<your SAM domain>)"
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
[[ -n "$POOL_ID" ]] || POOL_ID="sam-${INSTALL_HASH}"
printf '%s' "$POOL_ID" | grep -Eq '^[a-z][a-z0-9-]{3,31}$' || die "invalid --pool-id: $POOL_ID"
printf '%s' "$PROVIDER_ID" | grep -Eq '^[a-z][a-z0-9-]{3,31}$' || die "invalid --provider-id: $PROVIDER_ID"
printf '%s' "$SA_ID" | grep -Eq '^[a-z][a-z0-9-]{5,29}$' || die "invalid --service-account: $SA_ID"
SA_EMAIL="${SA_ID}@${PROJECT}.iam.gserviceaccount.com"
if [[ -n "$INSTALLATION_ID" ]]; then
  printf '%s' "$INSTALLATION_ID" | grep -Eq '^[a-f0-9]{32}$' || die "--installation-id must be the normalized 32 hex installation id"
fi
if [[ "$CREATE_FIREWALLS" -eq 1 ]]; then
  [[ -n "$INSTALLATION_ID" && -n "$AGENT_RANGES" ]] || die "--create-firewalls requires --installation-id and --agent-source-ranges"
  printf '%s' "$AGENT_RANGES" | grep -Eq '^[0-9a-fA-F:.,/]+$' || die "invalid --agent-source-ranges"
fi
# Only tokens SAM signs for the installation's own (platform) credential: SAM sets
# user_id = platform:<userId> for those and the bare owner id for a user's credential
# (gcpIdentityTokenUserId in apps/api/src/services/gcp-sts.ts). So a user's GCP credential that
# names this pool cannot reach the node service account, even if that user claimed the pool in
# SAM before the operator saved the platform credential.
CONDITION="assertion.iss == '${ISSUER}' && assertion.user_id.startsWith('platform:')"

# Read-only calls run in every mode; changes go through `change`.
change() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
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
    [[ "$attempt" -lt 5 ]] || break
    echo "Retrying in ${GCP_BOOTSTRAP_RETRY_SECONDS:-5}s (attempt ${attempt} of 5): a new service account takes a few seconds to appear to IAM, so the error above is expected once."
    sleep "${GCP_BOOTSTRAP_RETRY_SECONDS:-5}"
  done
  return 1
}

command -v gcloud >/dev/null 2>&1 || die "gcloud is not installed or not on PATH"

# Receipts contain public resource identifiers only, never credentials. Reuse never becomes
# creation proof; teardown will preserve resources that existed before this install.
record_resource() {
  [[ "$DRY_RUN" -eq 0 && -n "$INSTALLATION_ID" ]] || return 0
  node "$SCRIPT_DIR/created-resources.mjs" add "$STATE_DIR/created-resources.json" gcp "$1" "$2" "$3" gcp-bootstrap \
    "project=$PROJECT" "install=$ISSUER" "identity=$4" "pool=$POOL_ID" "environment=selfhost" "installation=$INSTALLATION_ID" "account=$SA_EMAIL" "member=${5:-}" "role=${6:-}"
}

# The OIDC provider trusts the issuer the install advertises: check it before trusting it.
if [[ "$CHECK_ISSUER" -eq 1 ]]; then
  discovery="$(curl -fsS --max-time 10 "${ISSUER}/.well-known/openid-configuration" 2>/dev/null)" \
    || die "could not read ${ISSUER}/.well-known/openid-configuration: the node setup trusts this install's token issuer, so it runs once the install answers (after \`pnpm selfhost:deploy\`; README order). --skip-issuer-check skips the check if you are sure ${ISSUER} is right."
  issuer_re="$(printf '%s' "$ISSUER" | sed 's/[.]/\\./g')"
  printf '%s' "$discovery" | grep -Eq "\"issuer\"[[:space:]]*:[[:space:]]*\"${issuer_re}\"" \
    || die "the install at ${ISSUER} does not advertise issuer ${ISSUER}; check --api-url"
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null)" \
  || die "cannot read project ${PROJECT}; run 'gcloud auth login' as a project owner"
[[ -n "$PROJECT_NUMBER" ]] || die "project ${PROJECT} has no project number"

echo "Project ${PROJECT} (${PROJECT_NUMBER}), issuer ${ISSUER}, pool ${POOL_ID}"
echo "Note: use a project dedicated to SAM nodes. The node service account's roles apply to the whole project, so in a shared project it could also change the box VM and its firewall."

# cloudbilling: read-only Compute Engine list prices for the node catalog (no IAM role needed;
# without it every GCP machine shows "Price unavailable"; box round R14).
change services enable "${NODE_APIS[@]}" --project="$PROJECT"

# A deleted pool still describes (state DELETED) and keeps its id for 30 days: reusing it as
# "exists" would then try to create a provider in a deleted pool (R13 D5).
pool_action=reused
if pool_state="$(gcloud iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT" \
  --location=global --format='value(state)' 2>/dev/null)"; then
  [[ "$pool_state" != "DELETED" ]] \
    || die "workload identity pool ${POOL_ID} was deleted (Google keeps a deleted pool for 30 days, and its id cannot be reused until it is purged). Either undelete it: gcloud iam workload-identity-pools undelete ${POOL_ID} --project=${PROJECT} --location=global, then run this again; or pass --pool-id <a new id> and put the new values in the platform credential (Admin -> Credentials)."
  # A disabled pool still reports state ACTIVE (`disabled` is a separate field) and exchanges no
  # tokens, so every node exchange would fail later.
  pool_disabled="$(gcloud iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT" \
    --location=global --format='value(disabled)')" || die "cannot read workload identity pool ${POOL_ID}"
  [[ "$pool_disabled" != [Tt][Rr][Uu][Ee] ]] \
    || die "workload identity pool ${POOL_ID} is disabled, and a disabled pool exchanges no tokens. Either enable it: gcloud iam workload-identity-pools update ${POOL_ID} --project=${PROJECT} --location=global --no-disabled, then run this again; or pass --pool-id <a new id>."
  # The service account binding below is pool-wide, so every provider in the pool would be
  # admitted: reuse the pool only when each provider in it (deleted ones too, which can be
  # undeleted) is PROVIDER_ID trusting this install's issuer.
  pool_providers="$(gcloud iam workload-identity-pools providers list --project="$PROJECT" \
    --location=global --workload-identity-pool="$POOL_ID" --show-deleted \
    --format='value(name,oidc.issuerUri)')" || die "cannot list the providers of pool ${POOL_ID}"
  while IFS=$'\t' read -r provider_name provider_issuer; do
    [[ -n "$provider_name" ]] || continue
    if [[ "${provider_name##*/}" != "$PROVIDER_ID" ]]; then
      die "pool ${POOL_ID} holds provider ${provider_name##*/} (issuer ${provider_issuer:-not OIDC}) besides ${PROVIDER_ID}, deleted providers included, and the node service account would admit every provider in the pool. Use another --pool-id."
    fi
    if [[ "$provider_issuer" != "$ISSUER" ]]; then
      die "pool ${POOL_ID} is not dedicated to this install: its provider ${PROVIDER_ID} trusts ${provider_issuer:-a non-OIDC issuer}, not ${ISSUER}. Use another --pool-id."
    fi
  done <<<"$pool_providers"
  echo "pool ${POOL_ID}: exists"
else
  pool_action=created
  change iam workload-identity-pools create "$POOL_ID" --project="$PROJECT" --location=global \
    --display-name="SAM ${ISSUER#https://api.}" \
    --description="Dedicated to the SAM install whose token issuer is ${ISSUER}"
fi

if [[ "$DRY_RUN" -eq 0 && -n "$INSTALLATION_ID" ]]; then
  pool_identity="$(gcloud iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT" --location=global --format='value(name)')"
  record_resource workload-identity-pool "$POOL_ID" "$pool_action" "$pool_identity"
fi

# SAM signs aud=https://iam.googleapis.com/<provider> (gcp-sts.ts).
AUDIENCE="https://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}"
provider_action=reused
if provider_state="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
  --format='value(state)' 2>/dev/null)"; then
  [[ "$provider_state" != "DELETED" ]] \
    || die "provider ${POOL_ID}/${PROVIDER_ID} was deleted (Google keeps it for 30 days). Undelete it: gcloud iam workload-identity-pools providers undelete ${PROVIDER_ID} --workload-identity-pool=${POOL_ID} --project=${PROJECT} --location=global, then run this again; or pass --provider-id <a new id>."
  provider_disabled="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
    --format='value(disabled)')" || die "cannot read provider ${POOL_ID}/${PROVIDER_ID}"
  [[ "$provider_disabled" != [Tt][Rr][Uu][Ee] ]] \
    || die "provider ${POOL_ID}/${PROVIDER_ID} is disabled, and a disabled provider exchanges no tokens. Either enable it: gcloud iam workload-identity-pools providers update-oidc ${PROVIDER_ID} --workload-identity-pool=${POOL_ID} --project=${PROJECT} --location=global --no-disabled, then run this again; or pass --provider-id <a new id>."
  current="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
    --format='value(oidc.issuerUri)')"
  [[ "$current" = "$ISSUER" ]] \
    || die "provider ${POOL_ID}/${PROVIDER_ID} already trusts ${current}, not ${ISSUER}; refusing to retarget it. Use another --pool-id."
  echo "provider ${PROVIDER_ID}: exists, issuer ${ISSUER}"
  # A provider made by an earlier version of this script admits every token of this issuer, and
  # one edited by hand may name another audience (every exchange would then fail): set both to
  # what this script creates. The attribute mapping is not checked: neither the condition nor the
  # pool-wide binding reads a mapped attribute.
  current_condition="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
    --format='value(attributeCondition)')" \
    || die "cannot read the attribute condition of provider ${POOL_ID}/${PROVIDER_ID}"
  current_audiences="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" \
    --format='value(oidc.allowedAudiences)')" \
    || die "cannot read the allowed audiences of provider ${POOL_ID}/${PROVIDER_ID}"
  if [[ "$current_condition" != "$CONDITION" || "$current_audiences" != "$AUDIENCE" ]]; then
    change iam workload-identity-pools providers update-oidc "$PROVIDER_ID" --project="$PROJECT" \
      --location=global --workload-identity-pool="$POOL_ID" --attribute-condition="$CONDITION" \
      --allowed-audiences="$AUDIENCE"
  fi
else
  # Only this install's platform tokens are admitted (attributeCondition), and only tokens
  # addressed to this provider: SAM signs aud=https://iam.googleapis.com/<provider> (gcp-sts.ts). Mapping
  # matches the guided setup (gcp-setup.ts).
  provider_action=created
  change iam workload-identity-pools providers create-oidc "$PROVIDER_ID" --project="$PROJECT" \
    --location=global --workload-identity-pool="$POOL_ID" --display-name="SAM API" \
    --issuer-uri="$ISSUER" \
    --allowed-audiences="$AUDIENCE" \
    --attribute-mapping="google.subject=assertion.sub,attribute.sam_user=assertion.user_id,attribute.sam_project=assertion.project_id" \
    --attribute-condition="$CONDITION"
fi

if [[ "$DRY_RUN" -eq 0 && -n "$INSTALLATION_ID" ]]; then
  provider_identity="$(gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" --project="$PROJECT" --location=global --workload-identity-pool="$POOL_ID" --format='value(name)')"
  record_resource workload-identity-provider "$PROVIDER_ID" "$provider_action" "$provider_identity"
fi

sa_existed=0
if exists iam service-accounts describe "$SA_EMAIL" --project="$PROJECT"; then
  sa_existed=1
  # A disabled account can be granted roles but mints no tokens, so every node exchange would fail.
  sa_disabled="$(gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" \
    --format='value(disabled)')" || die "cannot read service account ${SA_EMAIL}"
  [[ "$sa_disabled" != [Tt][Rr][Uu][Ee] ]] \
    || die "service account ${SA_EMAIL} is disabled, and a disabled account mints no tokens. Either enable it: gcloud iam service-accounts enable ${SA_EMAIL} --project=${PROJECT}, then run this again; or pass --service-account <a new id>."
  echo "service account ${SA_EMAIL}: exists"
else
  change iam service-accounts create "$SA_ID" --project="$PROJECT" --display-name="SAM nodes" \
    --description="Creates and deletes SAM workspace VMs and their firewall rules for ${ISSUER}"
fi

POOL_PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/*"
# add-iam-policy-binding only adds a member, so a reused account keeps every grant it already has:
# a member from an older --pool-id, or anyone given workloadIdentityUser, serviceAccountTokenCreator,
# serviceAccountUser or any other role on it, could act as the node account. Refuse while its policy
# holds anything but this pool's workloadIdentityUser binding, or a conditional binding;
# revoking is the operator's decision. This runs before ANY grant, the project roles included, so
# a member refused here never gains the node roles. The policy is parsed as JSON and anything
# unexpected refuses: a filter that silently matched nothing would let the grants through.
# User-managed keys are refused below. Roles inherited from the project, folder or organisation
# are not visible here; that is why the
# node project must be dedicated to SAM (README).
# A just-created account has an empty policy (and IAM may not list it yet), so it is skipped.
if [[ "$sa_existed" -eq 1 ]]; then
  sa_policy="$(gcloud iam service-accounts get-iam-policy "$SA_EMAIL" --project="$PROJECT" \
    --format=json)" || die "cannot read the IAM policy of ${SA_EMAIL}"
  # Prints one "role<TAB>member" per member other than this pool's workloadIdentityUser binding;
  # exits 2 on output that is not a policy, 3 on a conditional binding.
  parse_status=0
  stray="$(printf '%s' "$sa_policy" | POOL_PRINCIPAL="$POOL_PRINCIPAL" node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      let policy;
      try { policy = JSON.parse(text); } catch { process.exit(2); }
      if (policy === null || typeof policy !== "object" || Array.isArray(policy)) process.exit(2);
      const bindings = policy.bindings ?? [];
      if (!Array.isArray(bindings)) process.exit(2);
      for (const binding of bindings) {
        if (!binding || typeof binding.role !== "string" || !Array.isArray(binding.members)) process.exit(2);
        if (binding.condition) process.exit(3);
        for (const member of binding.members) {
          if (typeof member !== "string") process.exit(2);
          const ours = binding.role === "roles/iam.workloadIdentityUser" && member === process.env.POOL_PRINCIPAL;
          if (!ours) console.log(`${binding.role}\t${member}`);
        }
      }
    });
  ')" || parse_status=$?
  case "$parse_status" in
  0) ;;
  3) die "service account ${SA_EMAIL} has a conditional IAM binding; this script cannot tell who it admits. Remove it (gcloud iam service-accounts get-iam-policy ${SA_EMAIL} --project=${PROJECT}), then run this again; or pass --service-account <a new id>." ;;
  *) die "could not parse the IAM policy of ${SA_EMAIL}; refusing to grant anything." ;;
  esac
  if [[ -n "$stray" ]]; then
    role="${stray%%$'\t'*}"
    member="$(printf '%s' "${stray#*$'\t'}" | head -n 1)"
    role="$(printf '%s' "$role" | head -n 1)"
    printf '%s\n' "$member" | grep -Eq '^[A-Za-z0-9:/._@+*=-]+$' || member="(a member with unusual characters)"
    die "service account ${SA_EMAIL} grants ${role} to ${member}, which this install does not use; that member could act as the node account. Remove it: gcloud iam service-accounts remove-iam-policy-binding ${SA_EMAIL} --project=${PROJECT} --role=${role} --member=${member}, then run this again (every other member is refused the same way); or pass --service-account <a new id>."
  fi
  # A user-managed key authenticates as the account without any IAM binding, so the policy above
  # cannot show who holds one. Nodes never use keys (workload identity only): refuse any, and
  # anything that is not a JSON list, before the grants.
  sa_keys="$(gcloud iam service-accounts keys list --iam-account="$SA_EMAIL" --project="$PROJECT" \
    --managed-by=user --format=json)" || die "cannot list the keys of ${SA_EMAIL}"
  key_count=0
  key_count="$(printf '%s' "$sa_keys" | node -e '
    let text = "";
    process.stdin.on("data", (chunk) => (text += chunk));
    process.stdin.on("end", () => {
      let keys;
      try { keys = JSON.parse(text); } catch { process.exit(2); }
      if (!Array.isArray(keys)) process.exit(2);
      console.log(String(keys.length));
    });
  ')" || die "could not parse the key list of ${SA_EMAIL}; refusing to grant anything."
  [[ "$key_count" =~ ^[0-9]+$ ]] || die "could not parse the key list of ${SA_EMAIL}; refusing to grant anything."
  [[ "$key_count" -eq 0 ]] \
    || die "service account ${SA_EMAIL} has ${key_count} user-managed key(s); anyone holding one acts as the node account. Delete them (gcloud iam service-accounts keys list --iam-account=${SA_EMAIL} --managed-by=user, then gcloud iam service-accounts keys delete <key-id> --iam-account=${SA_EMAIL}), then run this again; or pass --service-account <a new id>."
fi

if [[ "$DRY_RUN" -eq 0 && -n "$INSTALLATION_ID" ]]; then
  sa_identity="$(gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT" --format='value(uniqueId)')"
  sa_action=created
  [[ "$sa_existed" -eq 0 ]] || sa_action=reused
  record_resource service-account "$SA_EMAIL" "$sa_action" "$sa_identity"
fi

for role in "${NODE_ROLES[@]}"; do
  grant_action=reused
  if [[ "$DRY_RUN" -eq 0 && -n "$INSTALLATION_ID" ]]; then
    policy="$(gcloud projects get-iam-policy "$PROJECT" --format=json)" || die "cannot read project IAM policy"
    grant_status=0
    printf '%s' "$policy" | ROLE="$role" MEMBER="serviceAccount:$SA_EMAIL" node -e '
      let text=""; process.stdin.on("data", x=>text+=x); process.stdin.on("end", ()=>{
        let p; try {p=JSON.parse(text)} catch {process.exit(2)}; if (!p || !Array.isArray(p.bindings ?? [])) process.exit(2);
        process.exit((p.bindings ?? []).some(b=>b.role===process.env.ROLE && b.members?.includes(process.env.MEMBER)) ? 0 : 10);
      });' || grant_status=$?
    case "$grant_status" in
      0) ;;
      10) grant_action=created ;;
      *) die "cannot parse project IAM policy" ;;
    esac
  fi
  change_retry projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${SA_EMAIL}" \
    --role="$role" --condition=None --quiet --format=none
  if [[ "$DRY_RUN" -eq 0 && -n "$INSTALLATION_ID" ]]; then
    record_resource iam-binding "projects/$PROJECT#$role#serviceAccount:$SA_EMAIL" "$grant_action" "$sa_identity" "serviceAccount:$SA_EMAIL" "$role"
  fi
done

# Scope: the whole pool. Its only provider (checked above on every run) admits only tokens whose
# issuer is this install's API origin, whose audience is that provider, and whose user_id is a
# platform identity, so the binding admits the tokens SAM signs for the installation's own
# credential and no user's. SAM also refuses a user credential that names a pool the platform
# credential holds (gcp-wif-pool-ownership.ts). Any provider added to this pool later would
# inherit the service account too, so do not add providers to it.
change_retry iam service-accounts add-iam-policy-binding "$SA_EMAIL" --project="$PROJECT" \
  --role=roles/iam.workloadIdentityUser --member="$POOL_PRINCIPAL" \
  --condition=None --quiet --format=none

# Optional: make only rules absent at creation time, preserving an ownership receipt.
# Existing same-name rules belong to whoever created them and are never adopted.
if [[ "$CREATE_FIREWALLS" -eq 1 ]]; then
  for rule in sam-allow-agent sam-allow-app-routes; do
    if gcloud compute firewall-rules describe "$rule" --project="$PROJECT" --format=json >/dev/null 2>&1; then
      echo "firewall $rule: exists; not adopted"
      continue
    fi
    ranges="$AGENT_RANGES"; ports=tcp:8080,tcp:8443; tag=sam-agent
    if [[ "$rule" == sam-allow-app-routes ]]; then ranges=0.0.0.0/0; ports=tcp:80,tcp:443; tag=sam-deployment-app-routes; fi
    description="SAM installation=$INSTALLATION_ID environment=selfhost issuer=$ISSUER"
    change compute firewall-rules create "$rule" --project="$PROJECT" --network=default --direction=INGRESS \
      --priority=1000 --target-tags="$tag" --allow="$ports" --source-ranges="$ranges" --description="$description"
    if [[ "$DRY_RUN" -eq 0 && -n "$INSTALLATION_ID" ]]; then
      identity="$(gcloud compute firewall-rules describe "$rule" --project="$PROJECT" --format='value(id)')"
      record_resource firewall-rule "$rule" created "$identity"
    fi
  done
fi

[[ "$DRY_RUN" -eq 1 ]] && echo "Dry run: nothing was changed."
# The shape parseGcpCredential (apps/api/src/services/provider-credential-codecs.ts) reads.
cat <<EOF

Add the installation's cloud account in SAM: Admin -> Credentials -> Add Credential,
Type "Cloud Provider", Provider "GCP", any label. Paste this as the API Token, with ZONE
replaced by the Compute Engine zone nodes use by default (for example europe-west1-b):

{"version":1,"provider":"gcp","authType":"workload-identity","gcpProjectId":"${PROJECT}","gcpProjectNumber":"${PROJECT_NUMBER}","serviceAccountEmail":"${SA_EMAIL}","wifPoolId":"${POOL_ID}","wifProviderId":"${PROVIDER_ID}","defaultZone":"ZONE"}

The values in it:
  Project ID:             ${PROJECT}
  Project number:         ${PROJECT_NUMBER}
  Pool ID:                ${POOL_ID}
  Provider ID:            ${PROVIDER_ID}
  Service account email:  ${SA_EMAIL}
Then add machines to the installation pool in Admin -> Infrastructure.
EOF
