/**
 * The Worker/DO suite does not exercise TTS, but src/index.ts eagerly imports
 * the TTS route and therefore @mastra/core/agent. Mastra's Node-oriented
 * package graph includes child_process and filesystem modules that cannot be
 * collected by the workerd test runner. Keep that unrelated graph outside the
 * harness and fail loudly if a Worker test starts exercising TTS.
 */
export class Agent {
  constructor() {
    throw new Error('@mastra/core/agent is unavailable in Worker/DO tests');
  }
}
