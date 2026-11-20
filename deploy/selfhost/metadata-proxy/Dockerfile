# Official Google auth SDK, with an isolated lockfile. No service-account key file.
FROM docker.io/library/node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1
WORKDIR /opt/sam-metadata-proxy
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY token.ts server.ts peer.ts ./
USER 65532:65532
ENTRYPOINT ["node", "server.ts"]
