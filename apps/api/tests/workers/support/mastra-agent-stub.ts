/**
 * Unrelated Workers pool tests cannot collect Mastra's Node module graph.
 * The separate native SAM suite bundles and executes the real library in workerd.
 * Fail loudly if an unrelated test crosses this seam instead of returning fake AI.
 */
export class Agent {
  constructor() {
    throw new Error('@mastra/core/agent is unavailable in Worker/DO tests');
  }
}

export class ModelRouterLanguageModel extends Agent {}
export class ModelsDevGateway extends Agent {}
export function createTool() {
  throw new Error('Mastra tools are exercised by the native SAM runtime suite');
}
