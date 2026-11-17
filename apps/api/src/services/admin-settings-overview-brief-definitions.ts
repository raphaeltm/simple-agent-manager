/**
 * Project Overview brief controls (inbox slice I). The definitions live in
 * `@simple-agent-manager/operations` beside the resolver the Overview read and the generator use;
 * this file registers them in the admin settings registry under "AI models", next to the other
 * platform model spend controls.
 */
import {
  PROJECT_BRIEF_ENABLED_SETTING,
  PROJECT_BRIEF_INTEGER_SETTINGS,
} from '@simple-agent-manager/operations';

import {
  type AdminSettingDefinition,
  integerDefinition,
  switchDefinition,
} from './admin-setting-definitions';

export const OVERVIEW_BRIEF_SETTINGS: AdminSettingDefinition[] = [
  switchDefinition(
    PROJECT_BRIEF_ENABLED_SETTING.name,
    PROJECT_BRIEF_ENABLED_SETTING.defaultValue,
    'AI models',
    PROJECT_BRIEF_ENABLED_SETTING.description,
    {}
  ),
  ...PROJECT_BRIEF_INTEGER_SETTINGS.map((setting) =>
    integerDefinition(
      setting.name,
      setting.defaultValue,
      'AI models',
      setting.description,
      setting.range
    )
  ),
];
