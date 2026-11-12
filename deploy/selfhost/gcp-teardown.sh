# shellcheck shell=bash
# `pnpm selfhost:gcp-bootstrap -- ... --teardown`: removes what gcp-bootstrap.sh created for this
# install, and nothing else. Sourced by gcp-bootstrap.sh (its options and helpers are in scope).
#
# What may be removed comes only from <state-dir>/created-resources.json, entries the bootstrap
# recorded as `created`. Each is then proven this install's again before it goes: the provider
# trusts this issuer, the pool's and the service account's descriptions name it, the key carries
# the label sam-install=<hash> the bootstrap set. Anything that fails its proof, anything recorded
# as `reused` (it existed before), and anything not in the record is left alone and reported.
#
# Cloud KMS (docs.cloud.google.com/kms/docs/delete-kms-resources, destroy-restore): a key version
# can be deleted only once DESTROYED, a key only once all its versions are deleted, a key ring only
# once all its keys are. Destroying is scheduled (30 days by default, restorable until then), and
# every version not yet destroyed is billed. So a teardown removes the grant at once; destroying
# the versions needs --destroy-key-versions <key id>; a later --teardown deletes the destroyed
# versions, then the key, then the ring. Key names cannot be reused once deleted.

declare -a REMOVED=() LEFT=()

removed() { # <kind> <name> <what>
  REMOVED+=("$3")
  [ "$DRY_RUN" -eq 1 ] || node "$RECORD_TOOL" removed "$RECORD" gcp "$1" "$2"
}

teardown_binding() { # <name: resource#role#member>
  local name="$1" resource role member key
  IFS='#' read -r resource role member <<<"$name"
  if [ "${resource#projects/*/locations/*/keyRings/*/cryptoKeys/}" != "$resource" ]; then
    key="${resource##*/}"
    if ! exists kms keys describe "$key" "${KEY_FLAGS[@]}"; then
      removed iam-binding "$name" "grant ${role} to ${member} on ${resource} (key already gone)"
      return
    fi
    change kms keys remove-iam-policy-binding "$key" "${KEY_FLAGS[@]}" --member="$member" \
      --role="$role" --format=none
  else
    change projects remove-iam-policy-binding "$PROJECT" --member="$member" --role="$role" \
      --condition=None --quiet --format=none
  fi
  removed iam-binding "$name" "grant ${role} to ${member} on ${resource}"
}

teardown_key() { # <key resource name>
  local name="$1" key="${1##*/}" owner versions active=0 destroyed=0 pending=0 version state
  if ! exists kms keys describe "$key" "${KEY_FLAGS[@]}"; then
    removed kms-key "$name" "key ${name} (already gone)"
    return
  fi
  owner="$(gcloud kms keys describe "$key" "${KEY_FLAGS[@]}" --format='value(labels.sam-install)')"
  if [ "$owner" != "$INSTALL_HASH" ]; then
    LEFT+=("key ${name}: not labelled sam-install=${INSTALL_HASH}; refused")
    return
  fi
  versions="$(gcloud kms keys versions list --key="$key" "${KEY_FLAGS[@]}" --format='value(name,state)')"
  # Read from fd 3: gcloud inside the loop may read stdin.
  while IFS=$'\t' read -r version state <&3; do
    [ -n "$version" ] || continue
    version="${version##*/}"
    case "$state" in
      ENABLED|DISABLED)
        if [ "$DESTROY_KEY" = "$key" ]; then
          change kms keys versions destroy "$version" --key="$key" "${KEY_FLAGS[@]}"
          pending=$((pending + 1))
        else
          active=$((active + 1))
        fi ;;
      DESTROY_SCHEDULED) pending=$((pending + 1)) ;;
      DESTROYED|IMPORT_FAILED|GENERATION_FAILED)
        change kms keys versions delete "$version" --key="$key" "${KEY_FLAGS[@]}" --quiet
        destroyed=$((destroyed + 1)) ;;
    esac
  done 3<<<"$versions"
  if [ "$active" -gt 0 ]; then
    LEFT+=("key ${name}: ${active} usable version(s), billed while they exist. Every sealed bundle and every backup of this box needs this key: destroying it makes them unrecoverable. To destroy: --teardown --destroy-key-versions ${key}")
  elif [ "$pending" -gt 0 ]; then
    LEFT+=("key ${name}: ${pending} version(s) scheduled for destruction (30 days by default; billed until destroyed; undo with: gcloud kms keys versions restore <version> --key=${key} --keyring=${KEY_RING} --location=${KMS_LOCATION} --project=${PROJECT}). Run --teardown again after that to delete the key and its key ring")
  else
    change kms keys delete "$key" "${KEY_FLAGS[@]}" --quiet
    removed kms-key "$name" "key ${name} (${destroyed} destroyed version(s) deleted; its name cannot be reused)"
  fi
}

teardown_ring() { # <ring resource name>
  local name="$1" ring="${1##*/}"
  if ! exists kms keyrings describe "$ring" --location="$KMS_LOCATION" --project="$PROJECT"; then
    removed kms-key-ring "$name" "key ring ${name} (already gone)"
  elif [ -n "$(gcloud kms keys list --keyring="$ring" --location="$KMS_LOCATION" --project="$PROJECT" --format='value(name)' 2>/dev/null)" ]; then
    LEFT+=("key ring ${name}: still holds keys (rings are free; deleted by a later --teardown once its keys are)")
  else
    change kms keyrings delete "$ring" --location="$KMS_LOCATION" --project="$PROJECT" --quiet
    removed kms-key-ring "$name" "key ring ${name}"
  fi
}

teardown_provider() {
  local name="$1" provider="${1##*/}" current
  if ! exists iam workload-identity-pools providers describe "$provider" --project="$PROJECT" \
    --location=global --workload-identity-pool="$POOL_ID"; then
    removed workload-identity-provider "$name" "provider ${name} (already gone)"
    return
  fi
  current="$(gcloud iam workload-identity-pools providers describe "$provider" --project="$PROJECT" \
    --location=global --workload-identity-pool="$POOL_ID" --format='value(oidc.issuerUri)')"
  if [ "$current" != "$ISSUER" ]; then
    LEFT+=("provider ${name}: trusts ${current}, not ${ISSUER}; refused")
    return
  fi
  change iam workload-identity-pools providers delete "$provider" --project="$PROJECT" \
    --location=global --workload-identity-pool="$POOL_ID" --quiet
  removed workload-identity-provider "$name" "provider ${name}"
}

teardown_pool() {
  local name="$1" description
  if ! exists iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT" --location=global; then
    removed workload-identity-pool "$name" "pool ${name} (already gone)"
    return
  fi
  description="$(gcloud iam workload-identity-pools describe "$POOL_ID" --project="$PROJECT" \
    --location=global --format='value(description)')"
  case "$description" in
    *"$ISSUER"*) ;;
    *) LEFT+=("pool ${name}: its description does not name ${ISSUER}; refused"); return ;;
  esac
  change iam workload-identity-pools delete "$POOL_ID" --project="$PROJECT" --location=global --quiet
  removed workload-identity-pool "$name" "pool ${name} (Google keeps a deleted pool 30 days; its id is not reusable until then)"
}

teardown_service_account() {
  local email="$1" description
  if ! exists iam service-accounts describe "$email" --project="$PROJECT"; then
    removed service-account "$email" "service account ${email} (already gone)"
    return
  fi
  description="$(gcloud iam service-accounts describe "$email" --project="$PROJECT" --format='value(description)')"
  case "$description" in
    *"$ISSUER"*) ;;
    *) LEFT+=("service account ${email}: its description does not name ${ISSUER}; refused"); return ;;
  esac
  change iam service-accounts delete "$email" --project="$PROJECT" --quiet
  removed service-account "$email" "service account ${email}"
}

run_teardown() {
  [ -f "$RECORD" ] || die "no record at ${RECORD}: this script removes only what it recorded creating. Pass --state-dir, or remove resources by hand (README, Sealed secrets)"
  local entries kind name action removed_at
  entries="$(node "$RECORD_TOOL" list "$RECORD" gcp "$TOOL")"
  echo "Teardown for ${ISSUER} in ${PROJECT} (record ${RECORD})"
  # Grants first, then what they point at; the key before its ring, the provider before its pool.
  for wanted in iam-binding kms-key kms-key-ring workload-identity-provider workload-identity-pool service-account; do
    while IFS=$'\t' read -r kind name action removed_at <&3; do
      [ "$kind" = "$wanted" ] && [ -z "$removed_at" ] || continue
      if [ "$action" != "created" ]; then
        LEFT+=("${kind} ${name}: existed before the bootstrap; kept")
        continue
      fi
      case "$kind" in
        iam-binding) teardown_binding "$name" ;;
        kms-key) teardown_key "$name" ;;
        kms-key-ring) teardown_ring "$name" ;;
        workload-identity-provider) teardown_provider "$name" ;;
        workload-identity-pool) teardown_pool "$name" ;;
        service-account) teardown_service_account "$name" ;;
      esac
    done 3<<<"$entries"
  done
  [ "$DRY_RUN" -eq 1 ] && echo "Dry run: nothing was changed."
  echo
  echo "Removed$([ "$DRY_RUN" -eq 1 ] && echo ' (would remove)'):"
  [ "${#REMOVED[@]}" -gt 0 ] && printf '  - %s\n' "${REMOVED[@]}" || echo "  (nothing)"
  echo "Left in place:"
  [ "${#LEFT[@]}" -gt 0 ] && printf '  - %s\n' "${LEFT[@]}" || echo "  (nothing)"
  echo "  - enabled APIs (shared with anything else in the project; free)"
}
