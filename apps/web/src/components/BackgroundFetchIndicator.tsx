import { useIsFetching } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { BACKGROUND_FETCH_DELAY_MS } from '../lib/project-query-config';

export function BackgroundFetchIndicator() {
  const backgroundFetchCount = useIsFetching({
    predicate: (query) => query.state.data !== undefined,
  });
  const isRefreshing = backgroundFetchCount > 0;
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (!isRefreshing) {
      setIsVisible(false);
      return;
    }

    const timer = window.setTimeout(() => setIsVisible(true), BACKGROUND_FETCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [isRefreshing]);

  return (
    <>
      <div
        aria-hidden="true"
        data-testid="background-fetch-indicator"
        data-refreshing={isVisible ? 'true' : 'false'}
        className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-0.5 bg-accent shadow-[0_0_8px_var(--sam-color-accent-primary)] transition-opacity duration-150 motion-reduce:transition-none ${
          isVisible ? 'opacity-100' : 'opacity-0'
        }`}
      />
      <span className="sr-only" role="status" aria-live="polite">
        {isVisible ? 'Refreshing data' : ''}
      </span>
    </>
  );
}
