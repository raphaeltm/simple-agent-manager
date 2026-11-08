import { bench, describe } from 'vitest';

import {
  getModelGroupsForAgent,
  getModelsForAgent,
  isKnownModel,
  parseCompose,
} from '../src/index';

// ---------------------------------------------------------------------------
// Representative Compose document — multi-service stack with x-sam extensions.
// Mirrors the kind of input parseCompose() handles on the deployment path.
// ---------------------------------------------------------------------------
const COMPOSE_YAML = `
services:
  api:
    image: ghcr.io/acme/api:v1.4.2
    command: node server.js
    environment:
      NODE_ENV: production
      PORT: "8080"
      LOG_LEVEL: info
    volumes:
      - data:/var/lib/api
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/health"]
      interval: 30s
      timeout: 5s
      retries: 3
  worker:
    image: ghcr.io/acme/worker@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    environment:
      - QUEUE_URL=redis://cache:6379
    volumes:
      - data:/var/lib/worker
  cache:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]

volumes:
  data:

x-sam-routes:
  - service: api
    port: 8080
    path: /

x-sam-pre-flight:
  service: api
  command: ["npm", "run", "migrate"]
  timeout: 120
`;

const SMALL_COMPOSE_YAML = `
services:
  app:
    image: nginx:1.27
x-sam-routes:
  - service: app
    port: 80
    path: /
`;

describe('compose-parser', () => {
  bench('parseCompose - multi-service stack', () => {
    parseCompose(COMPOSE_YAML);
  });

  bench('parseCompose - minimal single service', () => {
    parseCompose(SMALL_COMPOSE_YAML);
  });
});

// ---------------------------------------------------------------------------
// Model catalog lookups (called on UI render + server validation paths).
// ---------------------------------------------------------------------------
const AGENT_TYPES = ['claude-code', 'openai-codex', 'mistral-vibe', 'google-gemini', 'opencode'];

describe('model-catalog', () => {
  bench('getModelsForAgent - flatten all agent catalogs', () => {
    for (const agent of AGENT_TYPES) {
      getModelsForAgent(agent);
    }
  });

  bench('getModelGroupsForAgent - all agents', () => {
    for (const agent of AGENT_TYPES) {
      getModelGroupsForAgent(agent);
    }
  });

  bench('isKnownModel - hit and miss lookups', () => {
    isKnownModel('claude-code', 'claude-opus-4-8');
    isKnownModel('openai-codex', 'gpt-6-astra');
    isKnownModel('claude-code', 'nonexistent-model');
    isKnownModel('unknown-agent', 'whatever');
  });
});
