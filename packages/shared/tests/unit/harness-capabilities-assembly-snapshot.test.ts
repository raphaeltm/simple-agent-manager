import { describe, expect, it } from 'vitest';

import { AGENT_TYPE_VALUES } from '../../src/agents';
import { agentAssembler } from '../../src/composable-credentials/assemblers';
import type { CredentialSecret, ResolvedEnvironment } from '../../src/composable-credentials/types';

function resolved(
  agentType: string,
  source: ResolvedEnvironment['source'],
  secret: CredentialSecret | null
): ResolvedEnvironment {
  return {
    source,
    consumer: { kind: 'agent', agentType },
    credential: secret
      ? {
          id: 'cred',
          ownerId: 'user-1',
          name: 'credential',
          kind: secret.kind,
          secret,
          isActive: true,
        }
      : null,
    configuration: {
      id: 'cfg',
      ownerId: 'user-1',
      name: 'configuration',
      consumer: { kind: 'agent', agentType },
      credentialId: secret ? 'cred' : null,
      settings: {
        model: 'glm-4.6',
        baseUrl: 'https://provider.example/v1',
        samProxyBaseUrl: 'https://api.sam.example/ai/proxy/{wstoken}',
      },
      isActive: true,
    },
  };
}

describe('agent assembler harness capability snapshots', () => {
  it('preserves current env injection for platform sentinel and api-key credentials', () => {
    const output = Object.fromEntries(
      AGENT_TYPE_VALUES.map((agentType) => [
        agentType,
        {
          platform: agentAssembler.assemble(resolved(agentType, 'platform-proxy', null)),
          apiKey: agentAssembler.assemble(
            resolved(agentType, 'user-attachment', {
              kind: 'api-key',
              apiKey: `sk-${agentType}`,
            })
          ),
        },
      ])
    );

    expect(output).toMatchInlineSnapshot(`
      {
        "amp": {
          "apiKey": {
            "env": {
              "AMP_API_KEY": "sk-amp",
            },
            "files": [],
          },
          "platform": {
            "env": {
              "AMP_API_KEY": "__platform_proxy__",
            },
            "files": [],
          },
        },
        "claude-code": {
          "apiKey": {
            "env": {
              "ANTHROPIC_API_KEY": "sk-claude-code",
            },
            "files": [],
          },
          "platform": {
            "env": {
              "ANTHROPIC_API_KEY": "__platform_proxy__",
            },
            "files": [],
          },
        },
        "google-gemini": {
          "apiKey": {
            "env": {
              "GEMINI_API_KEY": "sk-google-gemini",
            },
            "files": [],
          },
          "platform": {
            "env": {
              "GEMINI_API_KEY": "__platform_proxy__",
            },
            "files": [],
          },
        },
        "mistral-vibe": {
          "apiKey": {
            "env": {
              "MISTRAL_API_KEY": "sk-mistral-vibe",
            },
            "files": [],
          },
          "platform": {
            "env": {
              "MISTRAL_API_KEY": "__platform_proxy__",
            },
            "files": [],
          },
        },
        "openai-codex": {
          "apiKey": {
            "env": {
              "OPENAI_API_KEY": "sk-openai-codex",
            },
            "files": [],
          },
          "platform": {
            "env": {
              "OPENAI_API_KEY": "__platform_proxy__",
            },
            "files": [],
          },
        },
        "opencode": {
          "apiKey": {
            "env": {
              "OPENCODE_API_KEY": "sk-opencode",
            },
            "files": [],
          },
          "platform": {
            "env": {
              "OPENCODE_API_KEY": "__platform_proxy__",
            },
            "files": [],
          },
        },
      }
    `);
  });

  it('preserves current oauth and openai-compatible edge behavior', () => {
    const output = Object.fromEntries(
      AGENT_TYPE_VALUES.map((agentType) => {
        const cases: Record<string, unknown> = {};
        try {
          cases.oauth = agentAssembler.assemble(
            resolved(agentType, 'user-attachment', {
              kind: 'oauth-token',
              token: `oauth-${agentType}`,
            })
          );
        } catch (error) {
          cases.oauthError = (error as Error).message;
        }
        try {
          cases.openaiCompatible = agentAssembler.assemble(
            resolved(agentType, 'user-attachment', {
              kind: 'openai-compatible',
              apiKey: 'sk-custom',
              baseUrl: 'https://secret.example/v1',
            })
          );
        } catch (error) {
          cases.openaiCompatibleError = (error as Error).message;
        }
        return [agentType, cases];
      })
    );

    expect(output).toMatchSnapshot();
  });
});
