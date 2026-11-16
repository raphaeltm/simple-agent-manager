import { Breadcrumb, PageLayout, Spinner } from '@simple-agent-manager/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Check, ChevronDown, Copy, Download, ExternalLink } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { getCliDownloadUrl, getCliVersion } from '../lib/api/cli';
import { API_URL } from '../lib/api/client';
import { PUBLIC_WEBSITE_URL } from '../lib/public-website';

/* ── Platform definitions ── */

interface PlatformDownload {
  os: string;
  arch: string;
  label: string;
  filename: string;
}

interface NavigatorWithUserAgentData extends Navigator {
  userAgentData?: {
    platform?: string;
  };
}

const PLATFORMS: PlatformDownload[] = [
  { os: 'darwin', arch: 'arm64', label: 'macOS Apple Silicon', filename: 'sam-darwin-arm64' },
  { os: 'darwin', arch: 'amd64', label: 'macOS Intel', filename: 'sam-darwin-amd64' },
  { os: 'linux', arch: 'amd64', label: 'Linux x86_64', filename: 'sam-linux-amd64' },
  { os: 'linux', arch: 'arm64', label: 'Linux ARM64', filename: 'sam-linux-arm64' },
];

/** Matches the CLI guide (apps/www/src/content/docs/docs/guides/cli.md). */
const QUICK_START_STEPS: { title: string; code: string; note?: string }[] = [
  {
    title: 'Sign in',
    code: `sam auth login --api-url ${API_URL}`,
    note: 'Opens your browser to authorize the CLI. Check that the code matches the one in your terminal.',
  },
  {
    title: 'Pick a project',
    code: `sam projects
sam project use <project-name>`,
  },
  {
    title: 'Start a chat',
    code: `sam chat new "Find out why the checkout tests are flaky"`,
  },
  {
    title: 'Submit a task and wait for it',
    code: `sam tasks submit --mode task --prompt "Add retries to the webhook sender, then open a pull request"
sam tasks wait <task-id> --timeout 30m`,
  },
];

/* ── Helpers ── */

function detectPlatform(): { os: string; arch: string } {
  const ua = navigator.userAgent.toLowerCase();
  let os = 'linux';
  let arch = 'amd64';

  if (ua.includes('mac')) os = 'darwin';
  const uaData = (navigator as NavigatorWithUserAgentData).userAgentData;
  if (uaData?.platform?.toLowerCase().includes('mac')) os = 'darwin';

  if (ua.includes('arm64') || ua.includes('aarch64')) arch = 'arm64';
  if (os === 'darwin') arch = 'arm64'; // Modern Macs are overwhelmingly Apple Silicon

  return { os, arch };
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [text]);

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className="bg-transparent border-none cursor-pointer p-1 flex items-center transition-colors duration-150"
      style={{ color: copied ? 'var(--accent)' : 'var(--fg-muted)' }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="bg-black/30 rounded-lg px-4 py-3.5 relative overflow-auto">
      <div className="absolute top-2 right-2">
        <CopyButton text={code} />
      </div>
      <pre className="m-0 text-[13px] leading-relaxed text-fg-primary whitespace-pre-wrap break-all pr-7">
        {code}
      </pre>
    </div>
  );
}

/* ── Main component ── */

export function ToolsCli() {
  const detected = useMemo(() => detectPlatform(), []);
  const [showAll, setShowAll] = useState(false);
  // Public build metadata, the same for every user, so the key needs no identity scope.
  const versionQuery = useQuery({ queryKey: ['cli', 'version'], queryFn: getCliVersion });
  const version = versionQuery.data;
  const loading = versionQuery.isLoading;

  // PLATFORMS is a non-empty const array — fallback to first entry if detection doesn't match
  const primaryMatch = PLATFORMS.find((p) => p.os === detected.os && p.arch === detected.arch);
  const primary: PlatformDownload = primaryMatch ?? {
    os: 'darwin',
    arch: 'arm64',
    label: 'macOS Apple Silicon',
    filename: 'sam-darwin-arm64',
  };
  const others = PLATFORMS.filter((p) => p.os !== primary.os || p.arch !== primary.arch);

  const curlOneLiner = `curl -fsSL "${getCliDownloadUrl(primary.os, primary.arch)}" -o sam && chmod +x sam && sudo mv sam /usr/local/bin/`;

  return (
    <PageLayout maxWidth="lg">
      <Breadcrumb
        segments={[
          { label: 'Home', path: '/dashboard' },
          { label: 'Tools', path: '/tools' },
          { label: 'SAM CLI' },
        ]}
      />

      {/* Back link */}
      <Link
        to="/tools"
        className="inline-flex items-center gap-1.5 text-[13px] text-fg-muted no-underline mt-1 mb-4"
      >
        <ArrowLeft size={14} />
        All Tools
      </Link>

      {/* Header with version badge */}
      <div className="flex items-baseline gap-3 mb-1.5">
        <h1 className="text-2xl font-semibold text-fg-primary m-0">SAM CLI</h1>
        {loading && <Spinner size="sm" />}
        {!loading && version?.available && (
          <span className="text-xs font-medium text-accent bg-accent/10 px-2 py-0.5 rounded-md">
            v{version.version}
          </span>
        )}
      </div>
      <p className="text-sm text-fg-muted m-0 mb-7 leading-relaxed">
        Start, follow and reply to chats and tasks from a terminal or a script.
      </p>

      {/* ── Download section ── */}
      <section className="rounded-xl border border-border-default bg-bg-card p-6 mb-4">
        <h2 className="text-base font-semibold text-fg-primary m-0 mb-4">Download</h2>

        <a
          href={getCliDownloadUrl(primary.os, primary.arch)}
          className="flex items-center justify-center gap-2.5 w-full py-3 px-5 bg-accent text-fg-on-accent font-semibold text-[15px] border-none rounded-lg no-underline transition-opacity duration-150 hover:opacity-90"
        >
          <Download size={18} />
          Download for {primary.label}
        </a>

        <div className="mt-3">
          <button
            onClick={() => setShowAll(!showAll)}
            className="bg-transparent border-none cursor-pointer text-fg-muted text-[13px] flex items-center gap-1 p-0"
          >
            <ChevronDown
              size={14}
              className="transition-transform duration-150"
              style={{ transform: showAll ? 'rotate(180deg)' : undefined }}
            />
            Other platforms
          </button>

          {showAll && (
            <div className="flex flex-col gap-2 mt-2.5">
              {others.map((p) => (
                <a
                  key={`${p.os}-${p.arch}`}
                  href={getCliDownloadUrl(p.os, p.arch)}
                  className="flex items-center gap-2 px-3.5 py-2.5 bg-inset border border-border-default rounded-lg text-fg-primary text-sm no-underline transition-colors duration-150 hover:border-accent"
                >
                  <Download size={14} className="text-fg-muted" />
                  {p.label}
                  <span className="text-xs text-fg-muted ml-auto">{p.filename}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* ── Install via curl ── */}
      <section className="rounded-xl border border-border-default bg-bg-card p-6 mb-4">
        <h2 className="text-base font-semibold text-fg-primary m-0 mb-3">Install via curl</h2>
        <p className="text-[13px] text-fg-muted m-0 mb-3">One-liner for {primary.label}:</p>
        <CodeBlock code={curlOneLiner} />
      </section>

      {/* ── Quick start ── */}
      <section className="rounded-xl border border-border-default bg-bg-card p-6 mb-4">
        <h2 className="text-base font-semibold text-fg-primary m-0 mb-4">Quick Start</h2>

        <div className="flex flex-col gap-5">
          {QUICK_START_STEPS.map((step, i) => (
            <div key={step.title}>
              <div className="flex items-center gap-2.5 mb-2">
                <span className="w-[22px] h-[22px] rounded-full bg-accent/10 text-accent text-xs font-bold flex items-center justify-center shrink-0">
                  {i + 1}
                </span>
                <span className="text-sm font-semibold text-fg-primary">{step.title}</span>
              </div>
              <CodeBlock code={step.code} />
              {step.note && (
                <p className="text-xs text-fg-muted m-0 mt-2 ml-8 italic">{step.note}</p>
              )}
            </div>
          ))}
        </div>

        <p className="text-[13px] text-fg-muted m-0 mt-5 leading-relaxed">
          For scripts and CI, create an API token under{' '}
          <Link to="/settings/access" className="text-accent">
            Settings → Access
          </Link>{' '}
          and set it as <code className="font-mono">SAM_API_TOKEN</code>, with{' '}
          <code className="font-mono">SAM_API_URL</code> set to{' '}
          <code className="font-mono break-all">{API_URL}</code>.
        </p>
      </section>

      {/* ── Footer links ── */}
      <div className="flex gap-5 flex-wrap text-[13px]">
        <a
          href={`${PUBLIC_WEBSITE_URL}/docs/guides/cli/`}
          target="_blank"
          rel="noreferrer"
          className="text-fg-muted no-underline flex items-center gap-1 hover:text-fg-primary"
        >
          <ExternalLink size={12} aria-hidden="true" />
          Full CLI guide
        </a>
        {!loading && version?.available && version.buildDate && (
          <span className="text-fg-muted opacity-60">
            Built {new Date(version.buildDate).toLocaleDateString()}
          </span>
        )}
      </div>
    </PageLayout>
  );
}
