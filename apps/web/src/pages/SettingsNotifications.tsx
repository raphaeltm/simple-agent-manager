import {
  NOTIFICATION_TYPES,
  type NotificationPreference,
  type NotificationPreferencesResponse,
  type NotificationType,
} from '@simple-agent-manager/shared';
import { Alert, Button, Card } from '@simple-agent-manager/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useIsStandalone } from '../hooks/useIsStandalone';
import { usePushSubscription } from '../hooks/usePushSubscription';
import { usePwaInstallPrompt } from '../hooks/usePwaInstallPrompt';
import { getNotificationPreferences, updateNotificationPreference } from '../lib/api';

const TYPE_LABELS: Record<NotificationType, { label: string; description: string }> = {
  task_complete: {
    label: 'Task Complete',
    description: 'When an agent finishes a task successfully',
  },
  needs_input: {
    label: 'Needs Input',
    description: 'When an agent needs your help or decision',
  },
  error: {
    label: 'Error / Failed',
    description: 'When a task fails or encounters an error',
  },
  progress: {
    label: 'Progress Update',
    description: 'When an agent reports progress on a task',
  },
  session_ended: {
    label: 'Session Ended',
    description: 'When an agent finishes its turn in a chat',
  },
  pr_created: {
    label: 'PR Created',
    description: 'When an agent creates a pull request',
  },
  cron_failure: {
    label: 'Operational Failure',
    description: 'When a scheduled recovery sweep reports a failure',
  },
};

/** A global preference is one not scoped to any project (`projectId === null`). */
function isGlobalInAppPref(pref: NotificationPreference): boolean {
  return pref.projectId === null && pref.channel === 'in_app';
}

export function SettingsNotifications() {
  const queryClient = useQueryClient();
  const preferencesQuery = useQuery({
    queryKey: ['notification-preferences'],
    queryFn: getNotificationPreferences,
    retry: false,
  });
  const preferences = preferencesQuery.data?.preferences ?? [];
  const push = usePushSubscription();
  const standalone = useIsStandalone();
  const installPrompt = usePwaInstallPrompt();

  const preferenceMutation = useMutation({
    mutationFn: async ({ type, enabled }: { type: NotificationType; enabled: boolean }) => {
      await updateNotificationPreference({
        notificationType: type,
        channel: 'in_app',
        enabled,
      });
      return { type, enabled };
    },
    onSuccess: ({ type, enabled }) => {
      queryClient.setQueryData<NotificationPreferencesResponse>(
        ['notification-preferences'],
        (previous) => {
          const preferences = previous?.preferences ?? [];
          const existing = preferences.findIndex(
            (preference) => preference.notificationType === type && isGlobalInAppPref(preference)
          );
          if (existing < 0) {
            return {
              preferences: [
                ...preferences,
                {
                  notificationType: type,
                  projectId: null,
                  channel: 'in_app',
                  enabled,
                },
              ],
            };
          }
          const updated = [...preferences];
          const existingPreference = updated[existing];
          if (!existingPreference) return previous;
          updated[existing] = { ...existingPreference, enabled };
          return { preferences: updated };
        }
      );
    },
  });

  const isEnabled = (type: NotificationType): boolean => {
    // Check specific type preference
    const typePref = preferences.find((p) => p.notificationType === type && isGlobalInAppPref(p));
    if (typePref) return typePref.enabled;

    // Check global default
    const globalPref = preferences.find((p) => p.notificationType === '*' && isGlobalInAppPref(p));
    if (globalPref) return globalPref.enabled;

    // Default: enabled
    return true;
  };

  const handleToggle = (type: NotificationType) => {
    preferenceMutation.mutate({ type, enabled: !isEnabled(type) });
  };

  const savingType = preferenceMutation.isPending ? preferenceMutation.variables?.type : null;
  const saveErrorType = preferenceMutation.error ? preferenceMutation.variables?.type : null;

  return (
    <div className="space-y-4">
      <Card variant="glass">
        <div className="p-4">
          <h3 className="text-sm font-semibold text-fg-primary mb-1">In-App Notifications</h3>
          <p className="text-xs text-fg-muted mb-4">
            Choose which notifications appear in your notification center.
          </p>

          {saveErrorType && (
            <p role="alert" className="text-xs text-danger mb-3">
              Could not save the &quot;{TYPE_LABELS[saveErrorType].label}&quot; setting. Please try
              again.
            </p>
          )}

          {preferencesQuery.error && preferencesQuery.data && (
            <p role="alert" className="mb-3 text-xs text-danger">
              Could not refresh notification preferences. Showing the last saved settings.
            </p>
          )}

          {preferencesQuery.isPending && !preferencesQuery.data ? (
            <p role="status" className="text-xs text-fg-muted">
              Loading preferences...
            </p>
          ) : preferencesQuery.error && !preferencesQuery.data ? (
            <div role="alert" className="space-y-2">
              <p className="text-xs text-danger">
                Could not load notification preferences. Please try again.
              </p>
              <button
                onClick={() => void preferencesQuery.refetch()}
                className="text-xs text-accent underline cursor-pointer border-none bg-transparent p-0"
              >
                Retry
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {NOTIFICATION_TYPES.map((type) => {
                const config = TYPE_LABELS[type];
                const enabled = isEnabled(type);
                const isSaving = savingType === type;

                return (
                  <div
                    key={type}
                    className="flex items-center justify-between py-2 border-b border-border-default last:border-0"
                  >
                    <div className="flex-1">
                      <div className="text-sm text-fg-primary">{config.label}</div>
                      <div className="text-xs text-fg-muted">{config.description}</div>
                    </div>
                    <button
                      onClick={() => handleToggle(type)}
                      disabled={isSaving}
                      className={`flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent ${
                        isSaving ? 'opacity-50' : ''
                      }`}
                      role="switch"
                      aria-checked={enabled}
                      aria-busy={isSaving}
                      aria-label={`${enabled ? 'Disable' : 'Enable'} ${config.label} notifications`}
                    >
                      <span
                        aria-hidden="true"
                        className={`relative h-5 w-10 rounded-full transition-colors ${
                          enabled ? 'bg-accent' : 'bg-border-default'
                        }`}
                      >
                        <span
                          className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                            enabled ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>

      <Card variant="glass">
        <div className="p-4">
          <h3 className="text-sm font-semibold text-fg-primary mb-1">Push Notifications</h3>
          <p className="text-xs text-fg-muted mb-4">
            Get urgent agent questions and task results even when SAM is not open.
          </p>

          {push.permission === 'denied' && (
            <Alert variant="warning" className="mb-3">
              Notifications are blocked in this browser. Allow them in your browser settings, then
              return here.
            </Alert>
          )}
          {push.error && (
            <Alert variant="error" className="mb-3">
              {push.error}
            </Alert>
          )}

          {push.isLoading ? (
            <p role="status" className="text-xs text-fg-muted">
              Checking push status...
            </p>
          ) : !push.supported ? (
            <p className="text-xs text-fg-muted">
              This browser does not support Web Push. Installing the app may enable it on mobile.
            </p>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm text-fg-primary">
                  {push.isSubscribed ? 'Push is on' : 'Push is off'}
                </p>
                <p className="text-xs text-fg-muted">
                  {push.isSubscribed
                    ? 'Urgent and medium-priority notifications will reach this browser.'
                    : 'Enable push to receive agent questions outside the open app.'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={push.isSubscribed}
                aria-busy={push.isBusy}
                aria-label={`${push.isSubscribed ? 'Disable' : 'Enable'} Web Push notifications`}
                disabled={push.isBusy || push.permission === 'denied'}
                onClick={() => void (push.isSubscribed ? push.disable() : push.enable())}
                className="flex min-h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center border-none bg-transparent disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span
                  aria-hidden="true"
                  className={`relative h-5 w-10 rounded-full transition-colors ${
                    push.isSubscribed ? 'bg-accent' : 'bg-border-default'
                  }`}
                >
                  <span
                    className={`absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
                      push.isSubscribed ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </span>
              </button>
            </div>
          )}

          {!standalone && (
            <div className="mt-4 border-t border-border-default pt-4">
              <p className="text-sm text-fg-primary">Install SAM</p>
              <p className="mt-1 text-xs text-fg-muted">
                Installation is required for push on iPhone and keeps SAM one tap away.
              </p>
              {installPrompt.canInstall ? (
                <Button
                  variant="secondary"
                  className="mt-3 min-h-11"
                  onClick={() => void installPrompt.install()}
                >
                  Install app
                </Button>
              ) : (
                <p className="mt-2 text-xs text-fg-muted">
                  On iPhone or iPad, use Share, then Add to Home Screen. On desktop, use your
                  browser&apos;s install action.
                </p>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
