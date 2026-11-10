# Shared paths for the spike scripts.
REPO=$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)
T=$REPO/experiments/selfhost-spike/tunnel
BIN=$REPO/.tmp/spike/bin
LOGS=$REPO/.tmp/spike/logs
export PATH=$BIN:$PATH
mkdir -p "$LOGS"
BOX_ADDR=${BOX_ADDR:-$(ip -4 -o addr show docker0 | awk '{print $4}' | cut -d/ -f1)}   # address nodes dial
token_for() { node --input-type=module -e "import crypto from 'node:crypto';process.stdout.write(crypto.createHmac('sha256',process.env.AUTHZ_SECRET||'spike-authz-secret').update('$1').digest('hex'))"; }
