#!/bin/bash
set -euo pipefail

redact() {
  sed -E \
    -e 's/(Bearer )[A-Za-z0-9._~+\/=-]{12,}/\1[REDACTED]/gI' \
    -e 's/(Authorization:[[:space:]]*)[^[:space:]]+/\1[REDACTED]/gI' \
    -e 's/(token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)(["'\'']?[[:space:]]*[:=][[:space:]]*["'\'']?)[^[:space:]"'\'',}]+/\1\2[REDACTED]/gI' \
    -e 's/gh[psuor]_[A-Za-z0-9_]{20,}/[REDACTED]/g' \
    -e 's/github_pat_[A-Za-z0-9_]{20,}/[REDACTED]/g'
}

tmp_output="$(mktemp)"
trap 'rm -f "$tmp_output"' EXIT

set +e
pulumi refresh --yes >"$tmp_output" 2>&1
status=$?
set -e

if [ "$status" -eq 0 ]; then
  cat "$tmp_output" | redact
  exit 0
fi

{
  echo "::error title=Pulumi refresh failed::Pulumi refresh failed before deployment mutations. Review the redacted diagnostics below, fix state/provider access, then re-run the workflow."
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
  tail -80 "$tmp_output" | redact
  echo '```'
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

tail -80 "$tmp_output" | redact >&2
exit "$status"
