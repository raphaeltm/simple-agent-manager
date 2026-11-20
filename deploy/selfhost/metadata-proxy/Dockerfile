# Official Google auth SDK, with an isolated lockfile. No service-account key file.
FROM docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
WORKDIR /opt/sam-metadata-proxy
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY token.ts server.ts peer.ts ./
USER 65532:65532
ENTRYPOINT ["node", "server.ts"]
