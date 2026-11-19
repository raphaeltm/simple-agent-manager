import type { Meta, StoryObj } from '@storybook/react';
import { Bell, MessageSquare, PanelRight } from 'lucide-react';

import { IconButton } from './IconButton';
import { Pane } from './Pane';

const meta: Meta<typeof IconButton> = {
  title: 'SAM Glass/IconButton',
  component: IconButton,
};

export default meta;
type Story = StoryObj<typeof IconButton>;

/** Plain, with counts (green running, amber waiting on you) and raised. */
export const Variants: Story = {
  render: () => (
    <Pane variant="slab" className="flex items-center gap-1 p-2">
      <div className="sam-well flex rounded-[14px] p-0.5">
        <IconButton label="Recent chats (3 active)" icon={<MessageSquare size={20} />} count={3} />
        <IconButton
          label="Notifications (2 need attention)"
          icon={<Bell size={20} />}
          count={2}
          countTone="attention"
        />
      </div>
      <IconButton raised label="Open chat list" icon={<PanelRight size={20} />} />
      <span className="ml-2 text-sm text-fg-muted">Counts live in each button&apos;s name.</span>
    </Pane>
  ),
};
