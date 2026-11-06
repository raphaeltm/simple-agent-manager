FROM node:22-bookworm-slim
ARG SPIKE_OVERRIDE
RUN test "$SPIKE_OVERRIDE" = present
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN npm install --build-from-source better-sqlite3@12.4.1
RUN node -e "require('better-sqlite3')(':memory:').exec('select 1')"
