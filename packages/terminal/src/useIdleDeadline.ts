import { useState, useEffect, useCallback } from 'react';

export interface UseIdleDeadlineOptions {
  /** Shutdown deadline as ISO 8601 timestamp */
  deadline?: string | null;
  /** Interval for updating countdown in ms (default: 1000) */
  updateInterval?: number;
}

export interface UseIdleDeadlineReturn {
  /** Time remaining until shutdown in seconds (null if no deadline) */
  remainingSeconds: number | null;
  /** Formatted string for display (e.g., "15 min", "5:30") */
  formattedRemaining: string | null;
  /** Deadline as Date object */
  deadlineDate: Date | null;
  /** Whether deadline is within 5 minutes (warning threshold) */
  isWarning: boolean;
  /** Whether deadline has passed */
  isExpired: boolean;
}

/**
 * Hook for tracking and displaying idle shutdown deadline.
 * Updates countdown every second.
 */
export function useIdleDeadline(options: UseIdleDeadlineOptions): UseIdleDeadlineReturn {
  const { deadline, updateInterval = 1000 } = options;

  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null);

  // Parse deadline to Date
  const deadlineDate = deadline ? new Date(deadline) : null;

  // Calculate remaining time
  const calculateRemaining = useCallback(() => {
    if (!deadlineDate) {
      setRemainingSeconds(null);
      return;
    }

    const now = new Date();
    const remaining = Math.max(0, (deadlineDate.getTime() - now.getTime()) / 1000);
    setRemainingSeconds(Math.floor(remaining));
  }, [deadlineDate]);

  // Update countdown on interval
  useEffect(() => {
    calculateRemaining();

    if (!deadline) return;

    const interval = setInterval(calculateRemaining, updateInterval);
    return () => clearInterval(interval);
  }, [deadline, updateInterval, calculateRemaining]);

  // Format remaining time for display
  const formatRemaining = (seconds: number | null): string | null => {
    if (seconds === null) return null;
    if (seconds <= 0) return 'Now';

    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;

    if (minutes >= 60) {
      const hours = Math.floor(minutes / 60);
      const mins = minutes % 60;
      return `${hours}h ${mins}m`;
    }

    if (minutes >= 10) {
      return `${minutes} min`;
    }

    return `${minutes}:${secs.toString().padStart(2, '0')}`;
  };

  const isWarning = remainingSeconds !== null && remainingSeconds <= 5 * 60; // 5 minutes
  const isExpired = remainingSeconds !== null && remainingSeconds <= 0;

  return {
    remainingSeconds,
    formattedRemaining: formatRemaining(remainingSeconds),
    deadlineDate,
    isWarning,
    isExpired,
  };
}

/**
 * Format a deadline for display in the status bar.
 */
export function formatDeadlineDisplay(
  deadlineDate: Date | null,
  remainingSeconds: number | null,
  isWarning: boolean
): string {
  if (!deadlineDate || remainingSeconds === null) {
    return '';
  }

  const time = deadlineDate.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (isWarning) {
    const minutes = Math.floor(remainingSeconds / 60);
    return `Shutting down in ${minutes} min at ${time}`;
  }

  return `Auto-shutdown at ${time}`;
}
