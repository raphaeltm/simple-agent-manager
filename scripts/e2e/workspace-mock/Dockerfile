# Reviewed source tag: docker.io/library/debian:bookworm-slim
FROM docker.io/library/debian@sha256:9c6e381421d0f48d1b8133e573f33c185ee16cbf505eda9c4a8a4791b25ea8a6

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates coreutils sed \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY mock-acp-agent.sh /usr/local/bin/mock-acp-agent
COPY mock-claude.sh /usr/local/bin/claude

RUN chmod +x /usr/local/bin/mock-acp-agent \
  && chmod +x /usr/local/bin/claude \
  && ln -s /usr/local/bin/mock-acp-agent /usr/local/bin/claude-agent-acp \
  && ln -s /usr/local/bin/mock-acp-agent /usr/local/bin/codex-acp \
  && ln -s /usr/local/bin/mock-acp-agent /usr/local/bin/gemini \
  && useradd --create-home --shell /bin/bash sam-mock \
  && chown -R sam-mock:sam-mock /workspace

USER sam-mock

CMD ["bash", "-lc", "sleep infinity"]
