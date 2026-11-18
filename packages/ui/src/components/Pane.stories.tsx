import type { Meta, StoryObj } from '@storybook/react';

import { Pane, PaneSeparator } from './Pane';

const meta: Meta<typeof Pane> = {
  title: 'SAM Glass/Pane',
  component: Pane,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof Pane>;

/** Every surface variant over the void, separated by the 14px gutter. */
export const Variants: Story = {
  render: () => (
    <div className="sam-void grid min-h-[420px] grid-cols-2 gap-[var(--sam-space-gutter)] p-4">
      <Pane className="p-4">
        <h2 className="m-0 text-base font-semibold">Pane</h2>
        <p className="m-0 mt-1 text-sm text-fg-muted">Sidebar, chat list, settings group.</p>
        <PaneSeparator className="my-3" />
        <p className="m-0 text-sm">A hairline separates groups inside a pane.</p>
      </Pane>
      <Pane variant="quiet" className="flex flex-col gap-3 p-4">
        <p className="m-0 text-sm">Quiet: the conversation other panes sit on.</p>
        <Pane variant="slab" className="p-4">
          <p className="m-0 text-sm">Slab: a header or message box laid on it.</p>
        </Pane>
      </Pane>
      <Pane variant="overlay" className="col-span-2 p-4">
        <p className="m-0 text-sm">Overlay: the one drawer or sheet with a live blur.</p>
      </Pane>
    </div>
  ),
};
