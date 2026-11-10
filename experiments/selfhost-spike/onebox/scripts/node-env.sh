# source me: node-env.sh <minio|seaweedfs>   sets celld env for the chosen local store
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
. "$HERE/scripts/stores.env"
export CELLD="${CELLD:-/workspaces/simple-agent-manager/.tmp/celld-dl/v0.6.2/celld}"
export CELLD_BUCKET=s3://celld-fleet
case "${1:-minio}" in
  minio) export S3_ENDPOINT=$MINIO_ENDPOINT AWS_ACCESS_KEY_ID=$MINIO_KEY AWS_SECRET_ACCESS_KEY=$MINIO_SECRET AWS_REGION=us-east-1 ;;
  seaweedfs) export S3_ENDPOINT=$SEAWEED_ENDPOINT AWS_ACCESS_KEY_ID=$SEAWEED_KEY AWS_SECRET_ACCESS_KEY=$SEAWEED_SECRET AWS_REGION=us-east-1 ;;
esac
