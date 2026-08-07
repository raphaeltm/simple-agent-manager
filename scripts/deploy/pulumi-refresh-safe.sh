#!/bin/bash
set -euo pipefail

redact() {
  awk '
    /-----BEGIN ([A-Z0-9 ]+ )?PRIVATE KEY-----/ {
      sub(/-----BEGIN.*/, "[REDACTED PRIVATE KEY BLOCK]")
      print
      in_private_key = 1
      next
    }
    in_private_key {
      if (/-----END ([A-Z0-9 ]+ )?PRIVATE KEY-----/) in_private_key = 0
      next
    }
    { print }
  ' | sed -E \
    -e 's/(Bearer )[A-Za-z0-9._~+\/=-]{12,}/\1[REDACTED]/gI' \
    -e 's/(Authorization:[[:space:]]*)[^[:space:]]+/\1[REDACTED]/gI' \
    -e 's/(token|secret|password|passwd|passphrase|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|private[_-]?key)(["'\'']?[[:space:]]*[:=][[:space:]]*["'\'']?).*/\1\2[REDACTED]/gI' \
    -e 's/gh[psuor]_[A-Za-z0-9_]{20,}/[REDACTED]/g' \
    -e 's/github_pat_[A-Za-z0-9_]{20,}/[REDACTED]/g'
}

tmp_output="$(mktemp)"
trap 'rm -f "$tmp_output"' EXIT

max_attempts="${PULUMI_REFRESH_MAX_ATTEMPTS:-3}"
retry_delay_seconds="${PULUMI_REFRESH_RETRY_DELAY_SECONDS:-5}"
diagnostic_tail_lines="${PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES:-80}"

if ! [[ "$max_attempts" =~ ^[1-9][0-9]*$ ]] || (( max_attempts > 5 )); then
  echo "::error::PULUMI_REFRESH_MAX_ATTEMPTS must be an integer from 1 through 5" >&2
  exit 2
fi

if ! [[ "$retry_delay_seconds" =~ ^[0-9]+$ ]] || (( retry_delay_seconds > 300 )); then
  echo "::error::PULUMI_REFRESH_RETRY_DELAY_SECONDS must be an integer from 0 through 300" >&2
  exit 2
fi

if ! [[ "$diagnostic_tail_lines" =~ ^[1-9][0-9]*$ ]] || (( diagnostic_tail_lines > 500 )); then
  echo "::error::PULUMI_REFRESH_DIAGNOSTIC_TAIL_LINES must be an integer from 1 through 500" >&2
  exit 2
fi

attempt=1
status=1
while (( attempt <= max_attempts )); do
  set +e
  pulumi refresh --yes >"$tmp_output" 2>&1
  status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    redact <"$tmp_output"
    exit 0
  fi

  if (( attempt < max_attempts )); then
    echo "::warning title=Pulumi refresh retry::Attempt ${attempt}/${max_attempts} failed with exit ${status}; retrying in ${retry_delay_seconds}s." >&2
    redact <"$tmp_output" | tail -n "$diagnostic_tail_lines" >&2
    sleep "$retry_delay_seconds"
    retry_delay_seconds=$((retry_delay_seconds * 2))
  fi

  attempt=$((attempt + 1))
done

{
  echo "::error title=Pulumi refresh failed::Pulumi refresh failed after ${max_attempts} attempt(s) before deployment mutations. Review the redacted diagnostics below, fix state/provider access, then re-run the workflow."
  echo ""
  echo "## Pulumi refresh failed"
  echo ""
  echo "Deployment failed closed before \`pulumi up\`."
  echo ""
  echo "Actionable checks:"
  echo "- Confirm the Pulumi R2 backend credentials can read/write the selected stack."
  echo "- Confirm CF_API_TOKEN and CF_ORIGIN_CA_KEY permissions for this GitHub Environment."
  echo "- Resolve drift or missing Cloudflare resources, then re-run deployment."
  echo ""
  echo "### Redacted refresh diagnostics"
  echo '```'
  redact <"$tmp_output" | tail -n "$diagnostic_tail_lines"
  echo '```'
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

redact <"$tmp_output" | tail -n "$diagnostic_tail_lines" >&2
exit "$status"
