import {
  DEFAULT_INFOMANIAK_BOOT_VOLUME_GB,
  INFOMANIAK_BOOT_VOLUME_MAX_GB,
  INFOMANIAK_BOOT_VOLUME_MIN_GB,
} from '@simple-agent-manager/shared';

import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

export type InfomaniakSettingName = 'infomaniak.bootVolumeGb';

export const INFOMANIAK_SETTINGS: readonly AdminSettingDefinition[] = [
  integerDefinition(
    'infomaniak.bootVolumeGb',
    DEFAULT_INFOMANIAK_BOOT_VOLUME_GB,
    'Operations',
    "Size in GB of the volume new Infomaniak VMs boot from, instead of the flavor's small local root disk. Applies to the catalog and new VMs from the next catalog refresh; running VMs keep their disk.",
    { min: INFOMANIAK_BOOT_VOLUME_MIN_GB, max: INFOMANIAK_BOOT_VOLUME_MAX_GB }
  ),
];
