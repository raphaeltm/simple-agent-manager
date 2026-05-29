import { Breadcrumb, PageLayout } from '@simple-agent-manager/ui';
import { ArrowRight, Github, Plug, Server, Terminal } from 'lucide-react';
import { Link } from 'react-router';

interface ToolCard {
  id: string;
  name: string;
  description: string;
  status: 'available' | 'coming-soon';
  path: string;
  icon: React.ReactNode;
}

const TOOLS: ToolCard[] = [
  {
    id: 'cli',
    name: 'SAM CLI',
    description:
      'Command-line tool for dispatching tasks, chatting with agents, and port-forwarding workspace services to your local machine.',
    status: 'available',
    path: '/tools/cli',
    icon: <Terminal size={24} />,
  },
  {
    id: 'mcp-server',
    name: 'MCP Server',
    description:
      'Connect SAM tools to Claude Code, Cursor, or any MCP-compatible host. Manage tasks, knowledge, and ideas from your editor.',
    status: 'coming-soon',
    path: '#',
    icon: <Plug size={24} />,
  },
  {
    id: 'runner',
    name: 'Self-Hosted Runner',
    description:
      'Install the SAM runner on your own hardware. Bring your GPU server, cloud VM, or homelab machine into your SAM fleet.',
    status: 'coming-soon',
    path: '#',
    icon: <Server size={24} />,
  },
  {
    id: 'github-app',
    name: 'GitHub App',
    description:
      'Automatic repo access for your SAM workspaces. Install once per org, all projects pick it up.',
    status: 'coming-soon',
    path: '#',
    icon: <Github size={24} />,
  },
];

export function Tools() {
  return (
    <PageLayout title="Tools" maxWidth="xl">
      <Breadcrumb
        segments={[
          { label: 'Home', path: '/dashboard' },
          { label: 'Tools' },
        ]}
      />

      <p className="text-sm text-fg-muted mt-1 mb-6">
        Download clients, install integrations, and connect your own infrastructure to SAM.
      </p>

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
        {TOOLS.map((tool) => {
          const isAvailable = tool.status === 'available';

          const content = (
            <div
              className={`rounded-xl border p-5 flex flex-col gap-3 transition-all duration-150
                ${isAvailable
                  ? 'border-border-default bg-bg-card cursor-pointer hover:border-accent hover:shadow-[0_0_0_1px_var(--accent)]'
                  : 'border-border-default bg-bg-card opacity-55'
                }`}
            >
              <div className="flex items-center justify-between">
                <div
                  className={`w-10 h-10 rounded-[10px] flex items-center justify-center
                    ${isAvailable ? 'bg-accent/10 text-accent' : 'bg-white/[0.04] text-fg-muted'}`}
                >
                  {tool.icon}
                </div>
                {!isAvailable && (
                  <span className="text-[11px] font-medium text-fg-muted bg-white/[0.05] px-2 py-0.5 rounded-md uppercase tracking-wide">
                    Coming soon
                  </span>
                )}
                {isAvailable && <ArrowRight size={16} className="text-fg-muted" />}
              </div>

              <h2 className="text-base font-semibold text-fg-primary m-0">{tool.name}</h2>

              <p className="text-[13px] text-fg-muted m-0 leading-relaxed">
                {tool.description}
              </p>
            </div>
          );

          if (isAvailable) {
            return (
              <Link key={tool.id} to={tool.path} className="no-underline text-inherit">
                {content}
              </Link>
            );
          }
          return <div key={tool.id}>{content}</div>;
        })}
      </div>
    </PageLayout>
  );
}
