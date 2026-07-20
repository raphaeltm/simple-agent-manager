import {
  DEFAULT_TRIGGER_DESCRIPTION_MAX_LENGTH,
  DEFAULT_TRIGGER_NAME_MAX_LENGTH,
} from '@simple-agent-manager/shared';

import { FOCUS_RING } from './trigger-form-support';

interface TriggerIdentityFieldsProps {
  description: string;
  name: string;
  onDescriptionChange: (value: string) => void;
  onNameChange: (value: string) => void;
}

export function TriggerIdentityFields({
  description,
  name,
  onDescriptionChange,
  onNameChange,
}: TriggerIdentityFieldsProps) {
  return (
    <>
      <div>
        <label htmlFor="trigger-name" className="block text-sm font-medium text-fg-primary mb-1">
          Name
        </label>
        <input
          id="trigger-name"
          type="text"
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="Daily code review"
          className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
          maxLength={DEFAULT_TRIGGER_NAME_MAX_LENGTH}
        />
      </div>

      <div>
        <label
          htmlFor="trigger-description"
          className="block text-sm font-medium text-fg-primary mb-1"
        >
          Description <span className="text-fg-muted font-normal">(optional)</span>
        </label>
        <input
          id="trigger-description"
          type="text"
          value={description}
          onChange={(event) => onDescriptionChange(event.target.value)}
          placeholder="Runs a daily code review on the main branch"
          className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm ${FOCUS_RING}`}
          maxLength={DEFAULT_TRIGGER_DESCRIPTION_MAX_LENGTH}
        />
      </div>
    </>
  );
}
