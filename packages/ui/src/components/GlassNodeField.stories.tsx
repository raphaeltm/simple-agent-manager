import '../glass/glass.css';

import type { Meta, StoryObj } from '@storybook/react';

import { GlassNodeField } from './GlassNodeField';

const meta: Meta<typeof GlassNodeField> = {
  title: 'Components/GlassNodeField',
  component: GlassNodeField,
  args: {
    mode: 'floor',
    density: 0.2,
  },
  parameters: { layout: 'fullscreen' },
  render: (args) => (
    <div style={{ position: 'relative', height: 440, overflow: 'hidden', background: 'var(--sam-color-bg-canvas)' }}>
      <GlassNodeField {...args} />
      <div
        className="sam-glass sam-glass-rim"
        style={{
          position: 'absolute',
          left: '50%',
          top: 48,
          width: 'min(340px, calc(100% - 32px))',
          transform: 'translateX(-50%)',
          borderRadius: 16,
          padding: '20px 22px',
          color: 'var(--sam-color-fg-primary)',
        }}
      >
        <strong style={{ display: 'block', fontSize: 16 }}>Nodes as lit glass</strong>
        <span style={{ fontSize: 14 }}>Each tile is a node; lit slots are agents running in its workspaces.</span>
      </div>
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof GlassNodeField>;

export const Floor: Story = {};

export const Flat: Story = {
  args: { mode: 'flat', pitch: 88 },
};
