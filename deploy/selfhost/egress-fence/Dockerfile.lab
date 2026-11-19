# Isolated privileged netns test runner; never a deployed service.
FROM docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        iproute2 \
        nftables \
        procps \
        util-linux \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@9.15.9 --activate
