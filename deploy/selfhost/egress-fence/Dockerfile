# The celld egress fence: applies the nftables table rendered by `pnpm selfhost:deploy`
# (.state/egress-fence.nft) and re-applies it whenever it goes missing or changes.
FROM alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f
# Pinned: the fence is a security control; a package update must be a reviewed change.
RUN apk add --no-cache nftables=1.1.3-r0
COPY fence.sh /usr/local/bin/sam-egress-fence
ENTRYPOINT ["/bin/sh", "/usr/local/bin/sam-egress-fence"]
CMD ["run"]
