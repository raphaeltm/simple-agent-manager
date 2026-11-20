# Caddy plus two modules: a DNS provider (DNS-01 for the wildcard certificate *.${SAM_DOMAIN})
# and caddy-ratelimit (anonymous frp Login probes, sam.d/frp.caddy).
#
# Reproducible on purpose (docker-compose.yml builds it only on an explicit `docker compose build`
# or when the image is missing):
# - both images are pinned by digest; the builder's CADDY_VERSION fixes Caddy itself;
# - every module is pinned by version, fetched only from the public Go module proxy and verified
#   against the Go checksum database (a published module version cannot change content);
# - GOTOOLCHAIN=local: a module asking for a newer Go fails the build instead of downloading one;
# - the build fails unless the binary carries exactly the requested module versions.
# Change the DNS provider with CADDY_DNS_MODULE=github.com/caddy-dns/<provider>@<version> in .env,
# add a matching tls/dns-<provider>.caddy snippet, then `docker compose build caddy`.
FROM caddy:2.11.9-builder@sha256:f9beaa5ddbe7df6f26ebbcf9cbf44e05a1917b9bba464f0c3229038d7e2e6e13 AS build
ARG CADDY_DNS_MODULE=github.com/caddy-dns/googleclouddns@v1.1.0
ARG CADDY_RATELIMIT_MODULE=github.com/mholt/caddy-ratelimit@v0.1.0
ENV GOPROXY=https://proxy.golang.org \
    GOSUMDB=sum.golang.org \
    GONOSUMDB= \
    GONOSUMCHECK= \
    GOPRIVATE= \
    GOINSECURE= \
    GOTOOLCHAIN=local
RUN set -eu; \
    for module in "$CADDY_DNS_MODULE" "$CADDY_RATELIMIT_MODULE"; do \
      case "$module" in \
        *@v[0-9]*) ;; \
        *) echo "module $module must be pinned as <path>@<version>" >&2; exit 1 ;; \
      esac; \
    done; \
    xcaddy build --output /usr/bin/caddy --with "$CADDY_DNS_MODULE" --with "$CADDY_RATELIMIT_MODULE"; \
    go version -m /usr/bin/caddy > /tmp/build-info; \
    for module in "$CADDY_DNS_MODULE" "$CADDY_RATELIMIT_MODULE"; do \
      grep -Eq "^[[:space:]]+dep[[:space:]]+${module%@*}[[:space:]]+${module#*@}[[:space:]]+h1:" /tmp/build-info \
        || { echo "caddy was not built with $module" >&2; cat /tmp/build-info >&2; exit 1; }; \
    done

FROM caddy:2.11.9@sha256:4851e54a46b206517c574821bb5cc67f170d2156041e9fbc4c9193b45e84a75b
COPY --from=build /usr/bin/caddy /usr/bin/caddy
# Never root. The file capability is the only privilege: it lets the unprivileged process bind
# 80/443, and compose keeps NET_BIND_SERVICE as the one capability (docker-compose.yml, service
# caddy). Set here rather than trusting COPY to carry the builder's. Caddy's state (XDG_DATA_HOME
# /data, XDG_CONFIG_HOME /config) belongs to the same uid; an existing box's volumes, written by
# a root Caddy, are handed over by the caddy-volumes service.
RUN setcap cap_net_bind_service=+ep /usr/bin/caddy \
    && chown -R 7101:7101 /data /config
USER 7101:7101
