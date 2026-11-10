# Caddy with a DNS provider module, needed for the DNS-01 wildcard certificate *.${SAM_DOMAIN}.
# Both images are pinned by digest; the module is pinned by version. Change the provider with
# --build-arg CADDY_DNS_MODULE=github.com/caddy-dns/<provider>@<version> and add a matching
# tls/dns-<provider>.caddy snippet.
FROM caddy:2.11.9-builder@sha256:3db11aead97f1fdff9c563d0dd8e7fba2e4c7031bef40f3e44fd1982f3e8366b AS build
ARG CADDY_DNS_MODULE=github.com/caddy-dns/googleclouddns@v1.1.0
RUN xcaddy build --with "${CADDY_DNS_MODULE}"

FROM caddy:2.11.9@sha256:ce773ec7a742ce15ee6bf2bb5f65882b9e2a4487b10733e6f1484f86e6b5d8bc
COPY --from=build /usr/bin/caddy /usr/bin/caddy
