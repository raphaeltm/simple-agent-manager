# The box-local key agent (scripts/selfhost/key-service.ts). No dependencies: Node's own net,
# crypto and fetch, run with type stripping. Runs as SAM_KEY_AGENT_UID (docker-compose.yml), never
# as root; server.ts refuses uid 0.
FROM docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
COPY bundle.ts bundle-store.ts peer.ts provider.ts providers.ts provider-file.ts provider-transit.ts \
  provider-gcp-kms.ts provider-azure-kv.ts provider-aws-kms.ts aws-sigv4.ts healthcheck.ts server.ts \
  /opt/sam-key-agent/
ENTRYPOINT ["node", "/opt/sam-key-agent/server.ts"]
