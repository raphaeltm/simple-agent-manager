# SPIKE ONLY. Exact Cloudflare Sandbox SDK 0.x DinD pattern; never merge.
FROM docker:dind
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /container-server/sandbox /sandbox
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /bin/bash /bin/bash
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /usr/lib/libreadline.so.8 /usr/lib/libreadline.so.8
COPY --from=docker.io/cloudflare/sandbox:0.12.14-musl /usr/lib/libreadline.so.8.2 /usr/lib/libreadline.so.8.2
RUN apk add --no-cache curl python3 time
COPY start-docker.sh /usr/local/bin/start-docker.sh
RUN chmod +x /usr/local/bin/start-docker.sh
COPY fixtures /fixtures
COPY measure.sh /usr/local/bin/measure.sh
ENTRYPOINT ["/bin/sh", "-c", "mountpoint -q /tmp || mount -t tmpfs none /tmp; exec /sandbox \"$@\"", "--"]
CMD ["/usr/local/bin/start-docker.sh"]
