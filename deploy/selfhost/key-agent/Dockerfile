# The box-local key agent (SAM_KEY_PROVIDER; scripts/selfhost/key-service.ts). No dependencies:
# Node's own http, crypto and fetch, run with type stripping.
FROM docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
COPY bundle.ts peer.ts provider.ts providers.ts provider-file.ts provider-transit.ts \
  provider-gcp-kms.ts provider-azure-kv.ts provider-aws-kms.ts aws-sigv4.ts server.ts \
  /opt/sam-key-agent/
ENTRYPOINT ["node", "/opt/sam-key-agent/server.ts"]
