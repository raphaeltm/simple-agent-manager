import type { Dialect } from './harness-capabilities';

export interface ProviderPreset {
  id: string;
  label: string;
  dialect: Dialect;
  baseUrl: string;
  suggestedModels: string[];
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: 'mistral',
    label: 'Mistral AI',
    dialect: 'native',
    baseUrl: 'https://api.mistral.ai/v1',
    suggestedModels: ['mistral-large-latest', 'codestral-latest', 'devstral-medium-latest'],
  },
  {
    id: 'cohere-north',
    label: 'Cohere North',
    dialect: 'openai-compatible',
    // Cohere documents this as its OpenAI SDK compatibility base URL.
    // https://docs.cohere.com/docs/compatibility-api
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    suggestedModels: ['command-a-03-2025', 'command-r-plus', 'command-r'],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    dialect: 'openai-compatible',
    // OpenRouter's OpenAI SDK integration uses this baseURL.
    // https://openrouter.ai/docs/guides/community/openai-sdk
    baseUrl: 'https://openrouter.ai/api/v1',
    suggestedModels: ['openai/gpt-5.5', 'anthropic/claude-sonnet-4.6', 'google/gemini-3.5-pro'],
  },
  {
    id: 'groq',
    label: 'Groq',
    dialect: 'openai-compatible',
    // Groq documents OpenAI compatibility at this base_url.
    // https://console.groq.com/docs/openai
    baseUrl: 'https://api.groq.com/openai/v1',
    suggestedModels: [
      'openai/gpt-oss-120b',
      'llama-3.3-70b-versatile',
      'moonshotai/kimi-k2-instruct',
    ],
  },
  {
    id: 'deepseek-anthropic',
    label: 'DeepSeek Anthropic API',
    dialect: 'anthropic',
    // DeepSeek's Anthropic-compatible API uses this Anthropic-format base_url.
    // https://api-docs.deepseek.com/guides/anthropic_api
    baseUrl: 'https://api.deepseek.com/anthropic',
    suggestedModels: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  },
];
