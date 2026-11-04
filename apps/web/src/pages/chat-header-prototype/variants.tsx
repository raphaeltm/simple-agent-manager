import { Chip, chipClassName, paneClassName } from '@simple-agent-manager/ui';
import { ChevronDown, ExternalLink, Globe, X } from 'lucide-react';
import { useState } from 'react';

import { CredentialLimitChip } from '../../components/credential-limits/CredentialLimitChip';
import { PublicPortsToggleRow } from '../../components/project-message-view/PublicPortsToggleRow';
import { SessionCommentChip } from '../../components/project-message-view/SessionCommentChip';
import { WorkspaceProfileBadge } from '../../components/project-message-view/SessionHeaderBadges';
import { MOCK_CREDENTIAL, MOCK_PORTS, MOCK_WORKSPACE } from './mock-data';

const noop = () => {};

interface HeaderProps {
  title: string;
  publicPorts: boolean;
  onTogglePublicPorts: () => void;
}

function PortLink({ compact = false }: { compact?: boolean }) {
  const port = MOCK_PORTS[0]!;
  return (
    <a
      href={port.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`${chipClassName({ tone: 'success', size: compact ? 'sm' : 'md' })} transition-[filter] hover:brightness-110`}
      title={`${port.label}: ${port.url}`}
    >
      <Globe size={compact ? 12 : 14} strokeWidth={1.75} aria-hidden="true" />
      {port.port}
    </a>
  );
}

/* ------------------------------------------------------------------ */
/* Today: the production header, reproduced with the same components. */
/* ------------------------------------------------------------------ */

export function CurrentHeader({ title, publicPorts, onTogglePublicPorts }: HeaderProps) {
  return (
    <div data-testid="proto-header" className={`${paneClassName('slab')} flex shrink-0 flex-col overflow-hidden`}>
      <div className="space-y-2.5 px-4 pt-3 pb-3.5">
        <div
          className="text-[17px] leading-snug font-semibold text-fg-primary"
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {title}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Chip tone="success" dot>Active</Chip>
          <WorkspaceProfileBadge workspace={MOCK_WORKSPACE} />
          <CredentialLimitChip credential={MOCK_CREDENTIAL} />
          <PortLink />
          <button type="button" className={chipClassName()}>+1 more</button>
          <SessionCommentChip unresolvedCommentCount={0} needsAttentionCommentCount={0} onOpenComments={noop} />
        </div>
      </div>
      <PublicPortsToggleRow enabled={publicPorts} saving={false} error={null} onToggle={onTogglePublicPorts} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* A: one line. Everything else lives in a sheet behind the title.    */
/* ------------------------------------------------------------------ */

export function OneLineHeader({ title, publicPorts, onTogglePublicPorts }: HeaderProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <div
        data-testid="proto-header"
        className={`${paneClassName('slab')} flex h-12 shrink-0 items-center gap-2 pr-2 pl-3.5`}
      >
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Session info"
          aria-expanded={open}
          data-testid="proto-open-info"
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 border-none bg-transparent p-0 text-left"
        >
          <span
            aria-label="Active"
            className="h-2 w-2 shrink-0 rounded-full bg-[var(--sam-status-success-fg)] shadow-[0_0_8px_var(--sam-status-success-fg)]"
          />
          <span className="min-w-0 flex-1 truncate text-[15px] font-semibold text-fg-primary">{title}</span>
          <ChevronDown size={16} className="shrink-0 text-fg-muted" aria-hidden="true" />
        </button>
        <PortLink compact />
      </div>

      {/* Sheet: transform/opacity only, so opening never re-lays out the conversation. */}
      <div
        aria-hidden="true"
        onClick={() => setOpen(false)}
        className={`fixed inset-0 z-[var(--sam-z-drawer-backdrop)] bg-black/50 transition-opacity duration-200 ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      <div
        role="dialog"
        aria-label="Session info"
        aria-hidden={!open}
        data-testid="proto-info-sheet"
        className={`${paneClassName('overlay', { rounded: false })} fixed inset-x-0 bottom-0 z-[var(--sam-z-drawer)] rounded-t-[var(--sam-radius-pane)] pb-5 transition-transform duration-300 ease-[cubic-bezier(0.22,1.2,0.36,1)] ${open ? 'translate-y-0' : 'pointer-events-none translate-y-full'}`}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-[var(--sam-hairline)]" />
        <div className="flex items-start gap-3 px-4 pt-3">
          <h2 className="m-0 flex-1 text-[17px] leading-snug font-semibold text-fg-primary">{title}</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="grid h-8 w-8 shrink-0 cursor-pointer place-items-center rounded-full border-none bg-[var(--sam-chip-bg)] text-fg-muted"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="flex flex-wrap gap-2 px-4 pt-3">
          <Chip tone="success" dot>Active</Chip>
          <WorkspaceProfileBadge workspace={MOCK_WORKSPACE} />
          <SessionCommentChip unresolvedCommentCount={0} needsAttentionCommentCount={0} onOpenComments={noop} />
        </div>
        <SheetSection label="Usage">
          <CredentialLimitChip credential={MOCK_CREDENTIAL} />
        </SheetSection>
        <SheetSection label="Ports">
          <PortList />
        </SheetSection>
        <div className="mt-3">
          <PublicPortsToggleRow enabled={publicPorts} saving={false} error={null} onToggle={onTogglePublicPorts} />
        </div>
      </div>
    </>
  );
}

function SheetSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 pt-4">
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-fg-muted uppercase">{label}</div>
      {children}
    </div>
  );
}

function PortList() {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {MOCK_PORTS.map((port) => (
        <li key={port.port}>
          <a
            href={port.url}
            target="_blank"
            rel="noopener noreferrer"
            className="flex h-10 items-center gap-2.5 rounded-lg px-2 text-sm text-fg-primary no-underline hover:bg-[var(--sam-chip-bg)]"
          >
            <Globe size={15} className="text-[var(--sam-status-success-fg)]" aria-hidden="true" />
            <span className="font-mono">{port.port}</span>
            <span className="flex-1 truncate text-fg-muted">{port.label}</span>
            <ExternalLink size={14} className="text-fg-muted" aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* B: title line + one sliding chip row that tucks away on scroll.   */
/* ------------------------------------------------------------------ */

export function SlimStripHeader({
  title,
  publicPorts,
  onTogglePublicPorts,
  collapsed,
}: HeaderProps & { collapsed: boolean }) {
  const [portsOpen, setPortsOpen] = useState(false);
  const [titleOpen, setTitleOpen] = useState(false);
  const showStrip = !collapsed || portsOpen;
  return (
    <div data-testid="proto-header" className={`${paneClassName('slab')} relative z-10 shrink-0`}>
      <button
        type="button"
        onClick={() => setTitleOpen((v) => !v)}
        aria-expanded={titleOpen}
        className="block w-full cursor-pointer border-none bg-transparent px-3.5 pt-2.5 pb-2 text-left"
      >
        <span
          className={`block text-[15px] leading-snug font-semibold text-fg-primary ${titleOpen ? '' : 'truncate'}`}
        >
          {title}
        </span>
      </button>

      {/* Layout changes once (shown or not); the row itself only fades and slides. */}
      {showStrip && (
        <div
          data-testid="proto-chip-strip"
          className="flex animate-[proto-strip-in_220ms_ease-out] gap-1.5 overflow-x-auto px-3.5 pb-2.5 [scrollbar-width:none] [mask-image:linear-gradient(to_right,black_85%,transparent)]"
        >
          <Chip tone="success" size="sm" dot>Active</Chip>
          <button
            type="button"
            onClick={() => setPortsOpen((v) => !v)}
            aria-expanded={portsOpen}
            data-testid="proto-ports-chip"
            className={`${chipClassName({ tone: 'success', size: 'sm' })} cursor-pointer`}
          >
            <Globe size={12} strokeWidth={1.75} aria-hidden="true" />
            5173 +1
            <ChevronDown size={12} aria-hidden="true" className={portsOpen ? 'rotate-180' : ''} />
          </button>
          <SessionCommentChip unresolvedCommentCount={0} needsAttentionCommentCount={0} onOpenComments={noop} />
          <CredentialLimitChip credential={MOCK_CREDENTIAL} />
          <WorkspaceProfileBadge workspace={MOCK_WORKSPACE} />
        </div>
      )}

      {portsOpen && (
        <div
          data-testid="proto-ports-popover"
          className={`${paneClassName('overlay')} absolute inset-x-2 top-full mt-1.5 animate-[proto-strip-in_180ms_ease-out] py-2`}
        >
          <div className="px-2">
            <PortList />
          </div>
          <PublicPortsToggleRow enabled={publicPorts} saving={false} error={null} onToggle={onTogglePublicPorts} />
        </div>
      )}
    </div>
  );
}
