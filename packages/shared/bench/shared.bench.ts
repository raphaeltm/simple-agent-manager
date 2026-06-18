import { bench, describe } from 'vitest';

import {
  getModelGroupsForAgent,
  getModelsForAgent,
  isKnownModel,
  parseCompose,
} from '../src/index';
import { parseTrialEvent } from '../src/trial';

// ---------------------------------------------------------------------------
// Representative Compose document — multi-service stack with x-sam extensions.
// Mirrors the kind of input parseCompose() handles on the trial onboarding path.
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
// Trial SSE event validation (valibot discriminated union).
// ---------------------------------------------------------------------------
const TRIAL_EVENTS: unknown[] = [
  {
    type: 'trial.started',
    trialId: 't1',
    projectId: 'p1',
    repoUrl: 'https://github.com/a/b',
    startedAt: 1,
  },
  { type: 'trial.progress', stage: 'Cloning repo', progress: 0.25, at: 2 },
  { type: 'trial.agent_activity', role: 'tool', text: 'reading file', toolName: 'fs.read', at: 3 },
  { type: 'trial.idea', ideaId: 'i1', title: 'Add tests', summary: 'Increase coverage', at: 4 },
  { type: 'trial.ready', projectId: 'p1', workspaceUrl: 'https://example.com', at: 5 },
];

describe('trial events', () => {
  bench('parseTrialEvent - mixed event stream', () => {
    for (const event of TRIAL_EVENTS) {
      parseTrialEvent(event);
    }
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
    isKnownModel('openai-codex', 'gpt-5.5-pro');
    isKnownModel('claude-code', 'nonexistent-model');
    isKnownModel('unknown-agent', 'whatever');
  });
});
