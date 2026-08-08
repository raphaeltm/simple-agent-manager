import './preview.css';

import type { Preview } from '@storybook/react-vite';

const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'SAM color theme',
      defaultValue: 'sam',
      toolbar: {
        icon: 'paintbrush',
        items: [
          { value: 'sam', title: 'Dark' },
          { value: 'sam-light', title: 'Light' },
        ],
      },
    },
  },
  initialGlobals: {
    theme: 'sam',
  },
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === 'sam-light' ? 'sam-light' : 'sam';
      document.documentElement.dataset.uiTheme = theme;
      document.body.dataset.uiTheme = theme;
      return Story();
    },
  ],
  parameters: {
    a11y: {
      test: 'error',
    },
    layout: 'centered',
  },
};

export default preview;
