import { Breadcrumb, PageLayout, Spinner } from '@simple-agent-manager/ui';
import { ArrowLeft, Check, ChevronDown, Copy, Download, ExternalLink } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';

import { type CliVersionInfo, getCliDownloadUrl, getCliVersion } from '../lib/api/cli';

/* ── Platform definitions ── */

interface PlatformDownload {
  os: string;
  arch: string;
  label: string;
  filename: string;
}

const PLATFORMS: PlatformDownload[] = [
  { os: 'darwin', arch: 'arm64', label: 'macOS Apple Silicon', filename: 'sam-darwin-arm64' },
  { os: 'darwin', arch: 'amd64', label: 'macOS Intel', filename: 'sam-darwin-amd64' },
  { os: 'linux', arch: 'amd64', label: 'Linux x86_64', filename: 'sam-linux-amd64' },
  { os: 'linux', arch: 'arm64', label: 'Linux ARM64', filename: 'sam-linux-arm64' },
];

const QUICK_START_STEPS = [
  {
    title: 'Authenticate',
    code: `# Copy your session cookie from the browser, then:
printf '%s' "$SAM_SESSION_COOKIE" | sam auth login \\
  --api-url https://api.simple-agent-manager.org \\
  --session-cookie-stdin`,
    note: 'Session cookies expire. Personal access tokens are coming soon.',
  },
  {
    title: 'Dispatch a task',
    code: `sam --project <PROJECT_ID> tasks dispatch \\
  --agent sam \\
  --prompt "Fix the flaky test in auth.test.ts"`,
  },
  {
    title: 'Start a chat',
    code: `sam --project <PROJECT_ID> chat "What changed in the last 3 PRs?"`,
  },
  {
    title: 'Check task status',
    code: `sam --project <PROJECT_ID> task status <TASK_ID>`,
  },
];

/* ── Helpers ── */

function detectPlatform(): { os: string; arch: string } {
  const ua = navigator.userAgent.toLowerCase();
  let os = 'linux';
  let arch = 'amd64';

  if (ua.includes('mac')) os = 'darwin';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uaData = (navigator as any).userAgentData;
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
  const [version, setVersion] = useState<CliVersionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getCliVersion()
      .then(setVersion)
      .catch(() => setVersion({ available: false, version: null, buildDate: null }))
      .finally(() => setLoading(false));
  }, []);

  // PLATFORMS is a non-empty const array — fallback to first entry if detection doesn't match
  const primaryMatch = PLATFORMS.find((p) => p.os === detected.os && p.arch === detected.arch);
  const primary: PlatformDownload = primaryMatch ?? {
    os: 'darwin', arch: 'arm64', label: 'macOS Apple Silicon', filename: 'sam-darwin-arm64',
  };
  const others = PLATFORMS.filter((p) => p.os !== primary.os || p.arch !== primary.arch);

  const curlOneLiner = `curl -fsSL "${getCliDownloadUrl(primary.os, primary.arch)}" -o sam && chmod +x sam && sudo mv sam /usr/local/bin/`;

  return (
    <PageLayout title="SAM CLI" maxWidth="lg">
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
        Dispatch tasks, chat with agents, and port-forward workspace services — all from your
        terminal.
      </p>

      {/* ── Download section ── */}
      <section className="rounded-xl border border-border-default bg-bg-card p-6 mb-4">
        <h2 className="text-base font-semibold text-fg-primary m-0 mb-4">Download</h2>

        <a
          href={getCliDownloadUrl(primary.os, primary.arch)}
          className="flex items-center justify-center gap-2.5 w-full py-3 px-5 bg-accent text-black font-semibold text-[15px] border-none rounded-lg no-underline transition-opacity duration-150 hover:opacity-90"
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
                  className="flex items-center gap-2 px-3.5 py-2.5 bg-white/[0.03] border border-border-default rounded-lg text-fg-primary text-sm no-underline transition-colors duration-150 hover:border-accent"
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
        <p className="text-[13px] text-fg-muted m-0 mb-3">
          One-liner for {primary.label}:
        </p>
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
      </section>

      {/* ── Footer links ── */}
      <div className="flex gap-5 flex-wrap text-[13px]">
        <Link to="/tools" className="text-fg-muted no-underline flex items-center gap-1">
          <ExternalLink size={12} />
          All tools
        </Link>
        {!loading && version?.available && version.buildDate && (
          <span className="text-fg-muted opacity-60">
            Built {new Date(version.buildDate).toLocaleDateString()}
          </span>
        )}
      </div>
    </PageLayout>
  );
}
