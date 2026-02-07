import type { Meta, StoryObj } from '@storybook/react';
import { StatusBadge } from './StatusBadge';

const meta: Meta<typeof StatusBadge> = {
  title: 'Components/StatusBadge',
  component: StatusBadge,
  args: {
    status: 'running',
  },
};

export default meta;
type Story = StoryObj<typeof StatusBadge>;

export const Running: Story = {};

export const Creating: Story = {
  args: { status: 'creating' },
};

export const Disconnected: Story = {
  args: { status: 'disconnected' },
};

export const MobileLabel: Story = {
  args: { status: 'running', label: 'Live on mobile' },
};
