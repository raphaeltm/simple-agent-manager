# sam-dns: the box's authoritative DNS server (compose profile `dns`). Both images are pinned by
# digest; Go modules are pinned by go.sum. Same base images as sam-mx.
# Go 1.26.11-alpine. Use the digest as the single authoritative image reference.
FROM golang@sha256:ae52b5bc6ed045a9ed26ab03dc19327a802a9cc9aa8b27ed57f5c6b60579b0bb AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/sam-dns .

# Alpine 3.24. The digest pins the exact runtime image.
FROM alpine@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
# Pinned: setcap is only used at build time, to let the unprivileged process bind port 53.
RUN apk add --no-cache libcap-utils=2.78-r0
COPY --from=build /out/sam-dns /usr/local/bin/sam-dns
# The file capability is the only privilege: compose runs it as an unprivileged uid with every
# other capability dropped (docker-compose.yml, service sam-dns).
RUN setcap cap_net_bind_service=+ep /usr/local/bin/sam-dns && apk del libcap-utils \
    && mkdir -p /var/lib/sam-dns && chown 7104:7104 /var/lib/sam-dns
# /var/lib/sam-dns: the zone cache volume; a new named volume takes this owner.
# Never root, even without compose's `user:` (which sets the same uid on the box).
USER 7104:7104
ENTRYPOINT ["/usr/local/bin/sam-dns"]
