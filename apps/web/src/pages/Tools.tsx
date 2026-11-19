import { Breadcrumb, PageLayout } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Github, Plug, Server, Terminal } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';

import { useQueryScope } from '../hooks/useQueryScope';
import { connectorSettingsQueryOptions } from '../lib/query-options/connector';

interface ToolCard {
  id: string;
  name: string;
  description: string;
  path: string;
  icon: ReactNode;
}

const CLI_TOOL: ToolCard = {
  id: 'cli',
  name: 'SAM CLI',
  description:
    'Start, follow and reply to chats and tasks from a terminal or a script. Downloads for macOS and Linux.',
  path: '/tools/cli',
  icon: <Terminal size={22} />,
};

const CONNECTOR_TOOL: ToolCard = {
  id: 'connector',
  name: 'SAM Connector',
  description:
    'Use SAM from Claude, ChatGPT, Claude Code or Codex: check on work, start chats and answer your agents.',
  path: '/settings/access',
  icon: <Plug size={22} />,
};

const GITHUB_TOOL: ToolCard = {
  id: 'github-app',
  name: 'GitHub App',
  description:
    'Give your projects access to GitHub repositories. Install it once on an account or organization.',
  path: '/settings/github',
  icon: <Github size={22} />,
};

const MCP_SERVERS_TOOL: ToolCard = {
  id: 'mcp-servers',
  name: 'MCP servers',
  description:
    'Give your agents tools from other services, such as Zapier, Linear or Notion, by adding their MCP endpoints.',
  path: '/settings/mcp-servers',
  icon: <Server size={22} />,
};

export function Tools() {
  const scope = useQueryScope();
  const connector = useQuery(connectorSettingsQueryOptions(scope));
  // The Connector can be switched off for an installation; then Settings → Access has no
  // "Connect an AI app" section. Show the card only once the installation says it is on, so a
  // card that leads nowhere never appears, even briefly.
  const connectorOn = connector.data?.enabled === true;
  const tools = [CLI_TOOL, ...(connectorOn ? [CONNECTOR_TOOL] : []), GITHUB_TOOL, MCP_SERVERS_TOOL];

  return (
    <PageLayout maxWidth="xl">
      <Breadcrumb segments={[{ label: 'Home', path: '/dashboard' }, { label: 'Tools' }]} />

      <h1 className="text-2xl font-bold text-fg-primary mt-3 mb-1">Tools</h1>
      <p className="text-sm text-fg-muted m-0 mb-6">
        Work with SAM from your terminal and your AI apps, and connect the services your agents use.
      </p>

      <ul aria-label="Tools" className="grid gap-4 grid-cols-1 sm:grid-cols-2 list-none m-0 p-0">
        {tools.map((tool) => (
          <li key={tool.id} className="min-w-0">
            <Link
              to={tool.path}
              className="group flex h-full flex-col gap-3 rounded-xl border border-border-default bg-bg-card p-5 no-underline text-inherit transition-colors duration-150 hover:border-accent focus-visible:border-accent"
            >
              <div className="flex items-center justify-between">
                <div className="w-10 h-10 rounded-[10px] flex items-center justify-center bg-accent/10 text-accent">
                  {tool.icon}
                </div>
                <ArrowRight
                  size={16}
                  aria-hidden="true"
                  className="text-fg-muted transition-colors group-hover:text-accent"
                />
              </div>
              <h2 className="text-base font-semibold text-fg-primary m-0">{tool.name}</h2>
              <p className="text-[13px] text-fg-muted m-0 leading-relaxed">{tool.description}</p>
            </Link>
          </li>
        ))}
      </ul>
    </PageLayout>
  );
}
