# Reviewed source tag: docker.io/library/debian:bookworm-slim
FROM docker.io/library/debian@sha256:913f6706df59a68922d1dd08f78c2476560a8d367897200a6005b00e5f67c2d5

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
