# Official Google auth SDK, with an isolated lockfile. No service-account key file.
FROM docker.io/library/node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
WORKDIR /opt/sam-metadata-proxy
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY token.ts server.ts peer.ts ./
USER 65532:65532
ENTRYPOINT ["node", "server.ts"]
