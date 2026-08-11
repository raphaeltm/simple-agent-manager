import {
  SAM_NODE_ID_LENGTH,
  SAM_NODE_ID_REGEX,
  VM_LOCATION_ID_MAX_LENGTH,
  VM_LOCATION_ID_REGEX,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

export const PlacementNodeIdSchema = v.pipe(
  v.string(),
  v.length(SAM_NODE_ID_LENGTH, 'nodeId must be a valid SAM node ID'),
  v.regex(SAM_NODE_ID_REGEX, 'nodeId must be a valid SAM node ID')
);

export const VMLocationSchema = v.pipe(
  v.string(),
  v.minLength(1, 'vmLocation is required'),
  v.maxLength(
    VM_LOCATION_ID_MAX_LENGTH,
    `vmLocation must be at most ${VM_LOCATION_ID_MAX_LENGTH} characters`
  ),
  v.regex(VM_LOCATION_ID_REGEX, 'vmLocation must be a valid provider location identifier')
);
