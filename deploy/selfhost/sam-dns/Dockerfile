# sam-dns: the box's authoritative DNS server (compose profile `dns`). Both images are pinned by
# digest; Go modules are pinned by go.sum.
# Go 1.26.11-alpine. The tag keeps dependency updates on the declared toolchain; the digest pins it.
FROM golang:1.27.4-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS build
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
