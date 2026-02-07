FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates coreutils sed \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY mock-acp-agent.sh /usr/local/bin/mock-acp-agent

RUN chmod +x /usr/local/bin/mock-acp-agent \
  && ln -s /usr/local/bin/mock-acp-agent /usr/local/bin/claude-code-acp \
  && ln -s /usr/local/bin/mock-acp-agent /usr/local/bin/codex-acp \
  && ln -s /usr/local/bin/mock-acp-agent /usr/local/bin/gemini

CMD ["bash", "-lc", "sleep infinity"]
