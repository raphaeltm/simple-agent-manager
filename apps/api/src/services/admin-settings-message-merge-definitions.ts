import { DEFAULT_MESSAGE_MERGE_CONFIG } from '@simple-agent-manager/project-data';

import {
  type AdminSettingDefinition,
  integerDefinition,
  switchDefinition,
} from './admin-setting-definitions';

export const MESSAGE_MERGE_SETTINGS: AdminSettingDefinition[] = [
  switchDefinition(
    'chat.toolCallMergingEnabled',
    DEFAULT_MESSAGE_MERGE_CONFIG.toolUpdatesEnabled,
    'Operations',
    'Store one current snapshot per agent tool call. Disable to resume individual tool notification rows.',
    {}
  ),
  switchDefinition(
    'chat.messageMergingEnabled',
    DEFAULT_MESSAGE_MERGE_CONFIG.enabled,
    'Operations',
    'Merge newly received assistant text chunks. Disable to seal open rows and resume individual inserts.',
    {}
  ),
  integerDefinition(
    'chat.messageMergeMaxRowBytes',
    DEFAULT_MESSAGE_MERGE_CONFIG.maxRowBytes,
    'Operations',
    'Maximum serialized bytes in a merged row and retry-state admission budget; oversized individual messages or retry states keep individual rows.',
    { min: 1024, max: 256 * 1024 }
  ),
  integerDefinition(
    'chat.messageMergeRecentIds',
    DEFAULT_MESSAGE_MERGE_CONFIG.recentIds,
    'Operations',
    'Recent reporter message IDs retained across callback credential rotation; at least a complete received batch is retained.',
    { min: 50, max: 2000 }
  ),
  integerDefinition(
    'chat.idleCleanupExtendIntervalMs',
    DEFAULT_MESSAGE_MERGE_CONFIG.idleExtendIntervalMs,
    'Operations',
    'How often agent chat output extends an idle chat session’s cleanup deadline, in milliseconds. Each extension adds this much slack, so cleanup never fires early and at most this much late; 0 extends on every message batch.',
    { min: 0, max: 300_000 }
  ),
];
