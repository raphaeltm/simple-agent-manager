# Reviewed source tag: docker.io/library/debian:bookworm-slim
FROM docker.io/library/debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates coreutils sed \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY mock-acp-agent.sh /usr/local/bin/mock-acp-agent

RUN chmod +x /usr/local/bin/mock-acp-agent \
  && ln -s /usr/local/bin/mock-acp-agent /usr/local/bin/claude-agent-acp \
  && ln -s /usr/local/bin/mock-acp-agent /usr/local/bin/codex-acp \
  && ln -s /usr/local/bin/mock-acp-agent /usr/local/bin/gemini \
  && useradd --create-home --shell /bin/bash sam-mock \
  && chown -R sam-mock:sam-mock /workspace

USER sam-mock

CMD ["bash", "-lc", "sleep infinity"]
