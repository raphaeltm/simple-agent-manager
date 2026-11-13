import type { NoticesPort } from '@simple-agent-manager/project-data';

import {
  parentWakeNotice,
  projectEventWakeNotice,
  safeNotice,
  scheduledMessageNotice,
  stallCheckinNotice,
} from '../services/sam-notice-builders';

/** SAM notice builders for messages SAM injects into a chat. */
export const noticesPort: NoticesPort = {
  safe: safeNotice,
  parentWake: parentWakeNotice,
  projectEventWake: projectEventWakeNotice,
  scheduledMessage: scheduledMessageNotice,
  stallCheckin: stallCheckinNotice,
};
