import type { Meta, StoryObj } from '@storybook/react';
import { Button } from './Button';

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  args: {
    children: 'Create Workspace',
    size: 'lg',
    variant: 'primary',
  },
};

export default meta;
type Story = StoryObj<typeof Button>;

export const Primary: Story = {};

export const Secondary: Story = {
  args: { variant: 'secondary', children: 'Cancel' },
};

export const Loading: Story = {
  args: { loading: true, children: 'Create Workspace' },
};

export const Danger: Story = {
  args: { variant: 'danger', children: 'Delete Workspace' },
};
