/**
 * MCP tool definitions — calling Cloudflare-hosted AI models (Workers AI) from an agent.
 */

export const AGENT_MODEL_TOOLS = [
  {
    name: 'list_ai_models',
    description:
      "List the Cloudflare-hosted AI models you may call with run_ai_model in this project — decision models (Clef), extraction (Clairic), classifiers, text, embeddings, speech, images and more — with prices and the project's remaining monthly budget. Pass {model} to get that model's full input/output schema before calling it, and {includeOthers: true} to also see models that exist but are not turned on. The project's own instructions say when to use which model.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        model: {
          type: 'string',
          description: 'Workers AI model id, e.g. @cf/cloudflare/clef-flash. Returns its schema.',
        },
        includeOthers: {
          type: 'boolean',
          description: 'Also list catalog models that are not turned on for you.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'run_ai_model',
    description:
      'Call one Cloudflare-hosted AI model that is turned on for you (see list_ai_models) and return its output. `input` goes to the model as-is and must follow its schema. Put workspace files anywhere in `input` as {"$file": "relative/path", "encoding": "base64" | "bytes" | "data-url"} (default base64), e.g. audio for Whisper or an image for a vision model. Binary or very large outputs are saved into your workspace (default .ai-outputs/, or `outputDirectory`) and returned as {"$savedFile": {path, contentType, sizeBytes}}. Each call is charged to the project\'s monthly AI model budget; the result shows the cost and what remains.',
    inputSchema: {
      type: 'object' as const,
      required: ['model', 'input'],
      properties: {
        model: {
          type: 'string',
          description:
            'Workers AI model id, e.g. @cf/cloudflare/clef-flash or @cf/openai/gpt-oss-120b.',
        },
        input: {
          type: 'object',
          description:
            'The model\'s input object. Examples — Clef: {state, questions}; Clairic: {state, fields}; text models: {messages, max_tokens}; Whisper: {audio: {"$file": "rec.mp3"}}.',
        },
        outputDirectory: {
          type: 'string',
          description: 'Relative workspace directory for saved outputs. Default .ai-outputs',
        },
      },
      additionalProperties: false,
    },
  },
];
