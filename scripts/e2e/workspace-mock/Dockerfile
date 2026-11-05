# Reviewed source tag: docker.io/library/debian:bookworm-slim
FROM docker.io/library/debian@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

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
