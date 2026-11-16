import { useEffect, useState } from 'react';

const MINUTE_MS = 60_000;

/**
 * The current time, re-read once a minute so relative labels ("12m", "4m left") stay true without
 * refetching. Paused while the tab is hidden and re-read when it is shown again.
 */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: number | undefined;
    const start = () => {
      window.clearInterval(timer);
      setNow(Date.now());
      timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    };
    const onVisibility = () => {
      if (document.hidden) window.clearInterval(timer);
      else start();
    };
    if (!document.hidden) timer = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  return now;
}
