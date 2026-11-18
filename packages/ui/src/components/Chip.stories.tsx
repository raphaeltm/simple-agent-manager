import type { Meta, StoryObj } from '@storybook/react';
import { User2 } from 'lucide-react';

import { Chip } from './Chip';
import { Pane } from './Pane';

const meta: Meta<typeof Chip> = {
  title: 'SAM Glass/Chip',
  component: Chip,
};

export default meta;
type Story = StoryObj<typeof Chip>;

export const Tones: Story = {
  render: () => (
    <Pane variant="slab" className="flex flex-wrap gap-2 p-4">
      <Chip tone="success" dot>
        Active
      </Chip>
      <Chip tone="info">Lightweight</Chip>
      <Chip icon={<User2 size={14} aria-hidden="true" />}>Your session</Chip>
      <Chip tone="warning">2 need you</Chip>
      <Chip tone="danger">Failed</Chip>
      <Chip tone="muted" size="sm">
        Idle
      </Chip>
    </Pane>
  ),
};
