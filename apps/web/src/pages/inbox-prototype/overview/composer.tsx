/**
 * PROTOTYPE ONLY — "start a task from the Overview" (idea section 11.6). The production
 * pieces of the new-chat box, unmodified: ProfileToControl ("To ⌄"), RunAccountButton
 * ("on Personal Max ⌄"), ProjectChatComposer (text box, attach, voice, send) and
 * ProfilePickerSheet. Submitting is mocked and never navigates: the box clears, a one-line
 * receipt appears, and the task shows in Running now.
 *
 * Phone: one row (the text box) until you type; then the To row unfolds above it.
 */
import { paneClassName } from '@simple-agent-manager/ui';
import { AlertTriangle, Check } from 'lucide-react';
import { useId, useState } from 'react';

import { ProfileToControl } from '../../../components/project-chat/profile-picker';
import { ProfilePickerSheet } from '../../../components/project-chat/profile-picker/ProfilePickerSheet';
import { RunAccountButton } from '../../../components/project-chat/profile-picker/RunAccountControl';
import { ProjectChatComposer } from '../../../components/project-chat/ProjectChatComposer';
import { must } from '../mock-data';
import type { Account } from './data';
import { PROFILES, PROJECT_ID } from './data';

export type StartReceipt = { title: string; failed: boolean } | null;

/** The task's title as the chat list would show it: its first line, trimmed. */
export function taskTitle(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

export function TaskComposer({
  accounts,
  mobile,
  receipt,
  onStart,
  onOpenReceipt,
  initialText = '',
  initialSheetOpen = false,
}: {
  accounts: Account[];
  mobile: boolean;
  receipt: StartReceipt;
  onStart: (text: string, profileName: string) => void;
  onOpenReceipt: () => void;
  initialText?: string;
  initialSheetOpen?: boolean;
}) {
  const [text, setText] = useState(initialText);
  const [profileId, setProfileId] = useState('p-opus');
  const [sheet, setSheet] = useState<{ open: boolean; anchor: DOMRect | null }>({
    open: initialSheetOpen,
    anchor: null,
  });
  const panelId = useId();
  const profile = must(PROFILES.find((p) => p.id === profileId) ?? PROFILES[0]);
  const account = must(accounts.find((a) => a.profiles.includes(profile.name)) ?? accounts[0]);
  const usages = new Map(
    PROFILES.map((p) => [
      p.id,
      (accounts.find((a) => a.profiles.includes(p.name)) ?? account).usage,
    ])
  );
  const expanded = !mobile || text.length > 0;

  return (
    <div
      className={`${paneClassName('slab')} relative z-20 flex shrink-0 flex-col gap-2 px-3 pt-2.5 pb-2.5`}
      data-testid="overview-composer"
    >
      {receipt && (
        <p
          role="status"
          className={`m-0 flex min-w-0 items-center gap-1.5 text-[13px] ${receipt.failed ? 'text-danger-fg' : 'text-[var(--sam-status-success-fg)]'}`}
        >
          {receipt.failed ? (
            <AlertTriangle size={14} aria-hidden="true" className="shrink-0" />
          ) : (
            <Check size={14} strokeWidth={2.5} aria-hidden="true" className="shrink-0" />
          )}
          <span className="min-w-0 truncate">
            {receipt.failed ? 'Couldn’t start: ' : 'Started: '}
            {receipt.title}
          </span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={onOpenReceipt}
            className="shrink-0 cursor-pointer border-0 bg-transparent p-0 text-[13px] text-accent"
          >
            {receipt.failed ? 'In Needs you' : 'Open chat'}
          </button>
        </p>
      )}
      {expanded && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div className="@container min-w-[9rem] flex-1">
            <ProfileToControl
              profile={profile}
              usage={account.usage}
              loading={false}
              disabled={false}
              onOpen={(anchor) => setSheet({ open: true, anchor })}
            />
          </div>
          <RunAccountButton
            label={account.label}
            chosen={false}
            open={false}
            panelId={panelId}
            disabled={false}
            onToggle={() => {}}
          />
        </div>
      )}
      <ProjectChatComposer
        value={text}
        onChange={setText}
        onSend={() => {
          if (!text.trim()) return;
          onStart(text, profile.name);
          setText('');
        }}
        sending={false}
        placeholder="Start a task…"
        transcribeApiUrl="/api/transcribe"
        agentProfiles={PROFILES}
        showShortcutHint={false}
        showAttachButton
        submitLabel="Send"
        focusOnMount={false}
      />
      <ProfilePickerSheet
        open={sheet.open}
        anchor={sheet.anchor}
        projectId={PROJECT_ID}
        profiles={PROFILES}
        selectedProfileId={profileId}
        pickerState={undefined}
        usages={usages}
        hiddenUpdating={false}
        hiddenUpdateError={null}
        onSelect={(id) => {
          setProfileId(id);
          setSheet({ open: false, anchor: null });
        }}
        onSetHidden={async () => {}}
        onClose={() => setSheet({ open: false, anchor: null })}
        onNewProfile={() => {}}
      />
    </div>
  );
}
