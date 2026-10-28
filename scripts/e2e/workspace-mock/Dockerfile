# Reviewed source tag: docker.io/library/debian:bookworm-slim
FROM docker.io/library/debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

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
