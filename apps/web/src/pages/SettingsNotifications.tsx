import {
  NOTIFICATION_TYPES,
  type NotificationPreference,
  type NotificationType,
} from '@simple-agent-manager/shared';
import { Card } from '@simple-agent-manager/ui';
import { useCallback,useEffect, useState } from 'react';

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
};

export function SettingsNotifications() {
  const [preferences, setPreferences] = useState<NotificationPreference[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const loadPreferences = useCallback(async () => {
    try {
      const result = await getNotificationPreferences();
      setPreferences(result.preferences);
    } catch (err) {
      console.error('Failed to load notification preferences:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPreferences();
  }, [loadPreferences]);

  const isEnabled = (type: NotificationType): boolean => {
    // Check specific type preference
    const typePref = preferences.find(
      (p) => p.notificationType === type && !p.projectId && p.channel === 'in_app'
    );
    if (typePref) return typePref.enabled;

    // Check global default
    const globalPref = preferences.find(
      (p) => p.notificationType === '*' && !p.projectId && p.channel === 'in_app'
    );
    if (globalPref) return globalPref.enabled;

    // Default: enabled
    return true;
  };

  const handleToggle = async (type: NotificationType) => {
    const currentlyEnabled = isEnabled(type);
    setSaving(type);

    try {
      await updateNotificationPreference({
        notificationType: type,
        channel: 'in_app',
        enabled: !currentlyEnabled,
      });

      // Update local state
      setPreferences((prev) => {
        const existing = prev.findIndex(
          (p) => p.notificationType === type && !p.projectId && p.channel === 'in_app'
        );
        if (existing >= 0) {
          const updated = [...prev];
          updated[existing] = { ...updated[existing]!, enabled: !currentlyEnabled };
          return updated;
        }
        return [
          ...prev,
          {
            notificationType: type,
            projectId: null,
            channel: 'in_app' as const,
            enabled: !currentlyEnabled,
          },
        ];
      });
    } catch (err) {
      console.error('Failed to update preference:', err);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-4">
          <h3 className="text-sm font-semibold text-fg-primary mb-1">
            In-App Notifications
          </h3>
          <p className="text-xs text-fg-muted mb-4">
            Choose which notifications appear in your notification center.
          </p>

          {loading ? (
            <p className="text-xs text-fg-muted">Loading preferences...</p>
          ) : (
            <div className="space-y-3">
              {NOTIFICATION_TYPES.map((type) => {
                const config = TYPE_LABELS[type];
                const enabled = isEnabled(type);
                const isSaving = saving === type;

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
                      type="button"
                      onClick={() => handleToggle(type)}
                      disabled={isSaving}
                      className={`relative w-10 h-5 rounded-full transition-colors cursor-pointer border-none ${
                        enabled ? 'bg-accent' : 'bg-border-default'
                      } ${isSaving ? 'opacity-50' : ''}`}
                      role="switch"
                      aria-checked={enabled}
                      aria-label={`${enabled ? 'Disable' : 'Enable'} ${config.label} notifications`}
                    >
                      <span
                        className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                          enabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
