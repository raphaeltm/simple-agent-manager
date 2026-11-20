# The box-local key agent (scripts/selfhost/key-service.ts). No dependencies: Node's own net,
# crypto and fetch, run with type stripping. Runs as SAM_KEY_AGENT_UID (docker-compose.yml), never
# as root; server.ts refuses uid 0.
FROM docker.io/library/node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
COPY bundle.ts bundle-store.ts peer.ts provider.ts providers.ts provider-file.ts provider-transit.ts \
  provider-gcp-kms.ts provider-azure-kv.ts provider-aws-kms.ts aws-sigv4.ts healthcheck.ts server.ts \
  /opt/sam-key-agent/
# Non-root by default too; Compose sets the real uid (SAM_KEY_AGENT_UID).
USER 65534:65534
ENTRYPOINT ["node", "/opt/sam-key-agent/server.ts"]
