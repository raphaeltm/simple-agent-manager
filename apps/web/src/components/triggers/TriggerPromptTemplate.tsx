import { DEFAULT_CRON_TEMPLATE_MAX_LENGTH } from '@simple-agent-manager/shared';
import type { RefObject } from 'react';

import { FOCUS_RING } from './trigger-form-support';

interface TriggerPromptTemplateProps {
  onChange: (value: string) => void;
  onInsertVariable: (value: string) => void;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  value: string;
  variables: Array<{ group: string; vars: string[] }>;
}

export function TriggerPromptTemplate({
  onChange,
  onInsertVariable,
  placeholder,
  textareaRef,
  value,
  variables,
}: TriggerPromptTemplateProps) {
  return (
    <div>
      <h3 className="text-sm font-medium text-fg-primary mb-2">Prompt Template</h3>
      <div className="flex flex-col md:flex-row gap-3">
        <div className="flex-1 min-w-0">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            rows={6}
            maxLength={DEFAULT_CRON_TEMPLATE_MAX_LENGTH}
            className={`w-full px-3 py-2 rounded-md text-fg-primary text-sm font-mono resize-y ${FOCUS_RING}`}
            aria-label="Prompt template"
          />
          <p className="text-xs text-fg-muted mt-1 m-0">
            {value.length}/{DEFAULT_CRON_TEMPLATE_MAX_LENGTH} characters
          </p>
        </div>
        <div className="md:w-48 shrink-0">
          <p className="text-xs font-medium text-fg-muted mb-2 m-0">Available Variables</p>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {variables.map((group) => (
              <div key={group.group}>
                <p className="text-xs font-semibold text-fg-muted uppercase tracking-wider mb-1 m-0">
                  {group.group}
                </p>
                {group.vars.map((variable) => (
                  <button
                    key={variable}
                    onClick={() => onInsertVariable(variable)}
                    className={`block w-full text-left px-2 py-1 text-xs font-mono text-accent hover:bg-surface-hover rounded cursor-pointer bg-transparent border-none ${FOCUS_RING}`}
                    title={`Insert {{${variable}}}`}
                  >
                    {`{{${variable}}}`}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
