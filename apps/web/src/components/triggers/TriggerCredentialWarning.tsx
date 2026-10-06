import type { TriggerResponse } from '@simple-agent-manager/shared';
import { AlertTriangle } from 'lucide-react';

export function TriggerCredentialWarning({ trigger }: { trigger: TriggerResponse }) {
  if (!trigger.credentialAttribution?.multiplayerActive) return null;

  const personalChecks = trigger.credentialAttribution?.checks.filter(
    (check) => check.source === 'personal'
  ) ?? [];
  if (personalChecks.length === 0) return null;

  return (
    <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-tint px-3 py-2 text-xs text-warning-fg">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <div className="font-semibold text-fg-primary">Personal credential attribution</div>
        <div className="mt-0.5 grid gap-0.5">
          {personalChecks.map((check) => (
            <div key={`${check.consumerKind}-${check.consumerTarget}`}>
              {check.warning ?? `This ${check.consumerKind} path runs on a personal key.`}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
