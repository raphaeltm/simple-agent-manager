# The celld egress fence: applies the nftables table rendered by `pnpm selfhost:deploy`
# (.state/egress-fence.nft), then latches unhealthy if it goes missing or changes.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
# Pinned: the fence is a security control; a package update must be a reviewed change.
RUN apk add --no-cache nftables=1.1.3-r0
COPY fence.sh /usr/local/bin/sam-egress-fence
ENTRYPOINT ["/bin/sh", "/usr/local/bin/sam-egress-fence"]
CMD ["run"]
