# sam-mx: the inbound SMTP receiver for agent email (compose profile `mail-in`). Both images are
# pinned by digest; Go modules are pinned by go.sum.
# Go 1.26.11-alpine. Use the digest as the single authoritative image reference.
FROM golang@sha256:ae52b5bc6ed045a9ed26ab03dc19327a802a9cc9aa8b27ed57f5c6b60579b0bb AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/sam-mx .

# Alpine 3.24. The digest pins the exact runtime image.
FROM alpine@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
# Pinned: setcap is only used at build time, to let the unprivileged process bind port 25.
RUN apk add --no-cache libcap-utils=2.78-r0
COPY --from=build /out/sam-mx /usr/local/bin/sam-mx
# The file capability is the only privilege: compose runs it as an unprivileged uid with every
# other capability dropped (docker-compose.yml, service sam-mx).
RUN setcap cap_net_bind_service=+ep /usr/local/bin/sam-mx && apk del libcap-utils
# Never root, even without compose's `user:` (which sets the same uid on the box).
USER 7102:7102
ENTRYPOINT ["/usr/local/bin/sam-mx"]
