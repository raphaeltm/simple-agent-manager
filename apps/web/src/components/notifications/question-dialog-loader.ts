import { lazy } from 'react';

import { importWithRetry } from '../../lib/lazy-with-retry';

export const NotificationQuestionDialog = lazy(() =>
  importWithRetry(() => import('./NotificationQuestionDialog')).then((module) => ({
    default: module.NotificationQuestionDialog,
  }))
);
