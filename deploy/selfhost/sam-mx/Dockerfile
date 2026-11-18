# sam-mx: the inbound SMTP receiver for agent email (compose profile `mail-in`). Both images are
# pinned by digest; Go modules are pinned by go.sum.
FROM golang:1.27.3-alpine@sha256:fa3d596898d9f126af7c01d14ee7597bab3f39cccf392ef36b69fe77cd681f18 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/sam-mx .

FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
# Pinned: setcap is only used at build time, to let the unprivileged process bind port 25.
RUN apk add --no-cache libcap-utils=2.78-r0
COPY --from=build /out/sam-mx /usr/local/bin/sam-mx
# The file capability is the only privilege: compose runs it as an unprivileged uid with every
# other capability dropped (docker-compose.yml, service sam-mx).
RUN setcap cap_net_bind_service=+ep /usr/local/bin/sam-mx && apk del libcap-utils
# Never root, even without compose's `user:` (which sets the same uid on the box).
USER 7102:7102
ENTRYPOINT ["/usr/local/bin/sam-mx"]
