# The Docker socket proxy celld talks to when guided credential login is on
# (deploy/selfhost/docker-compose.guided-login.yml). No dependencies: Node's own http module and
# type stripping run policy.ts and server.ts as written.
FROM docker.io/library/node:22-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436
# The socket directory, owned by the proxy uid and readable by celld's group: a fresh named
# volume mounted here takes this ownership, and celld (CELLD_UID) connects through its group.
ARG PROXY_UID=7102
ARG CELLD_GID=7101
RUN mkdir -p /run/sam-docker-proxy && chown "${PROXY_UID}:${CELLD_GID}" /run/sam-docker-proxy \
  && chmod 0750 /run/sam-docker-proxy
COPY policy.ts shapes.ts server.ts /opt/sam-docker-proxy/
USER ${PROXY_UID}:${CELLD_GID}
ENTRYPOINT ["node", "/opt/sam-docker-proxy/server.ts"]
