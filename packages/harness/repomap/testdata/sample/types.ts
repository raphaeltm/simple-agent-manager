export interface Provider {
  send(message: string): Promise<string>;
}

export type Config = {
  apiKey: string;
  model: string;
};

export class AgentLoop {
  constructor(private provider: Provider) {}

  async run(prompt: string): Promise<string> {
    return this.provider.send(prompt);
  }
}

export const DEFAULT_MODEL = "gpt-4";

export function createAgent(config: Config): AgentLoop {
  return new AgentLoop({} as Provider);
}

export async function processTask(task: string): Promise<void> {
  console.log(task);
}

interface InternalState {
  running: boolean;
}

type RequestBody = {
  prompt: string;
};
