import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getFileList: vi.fn(),
}));

vi.mock('../../../src/lib/api', () => ({
  getFileList: mocks.getFileList,
}));

import { FileBrowserPanel } from '../../../src/components/FileBrowserPanel';

const defaultProps = {
  workspaceUrl: 'https://ws-test.example.com',
  workspaceId: 'ws-123',
  token: 'test-token',
  isMobile: false,
  onClose: vi.fn(),
  onSelectFile: vi.fn(),
  onNavigate: vi.fn(),
};

describe('FileBrowserPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows spinner while loading', () => {
    mocks.getFileList.mockReturnValue(new Promise(() => {}));
    render(<FileBrowserPanel {...defaultProps} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('shows error message on fetch failure', async () => {
    mocks.getFileList.mockRejectedValue(new Error('Permission denied'));
    render(<FileBrowserPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('Permission denied')).toBeInTheDocument();
    });
  });

  it('shows "This directory is empty" when no entries', async () => {
    mocks.getFileList.mockResolvedValue({ path: '.', entries: [] });
    render(<FileBrowserPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('This directory is empty')).toBeInTheDocument();
    });
  });

  it('renders directories and files', async () => {
    mocks.getFileList.mockResolvedValue({
      path: '.',
      entries: [
        { name: 'src', type: 'dir', size: 4096, modifiedAt: '2024-01-01T00:00:00Z' },
        { name: 'README.md', type: 'file', size: 1234, modifiedAt: '2024-01-01T00:00:00Z' },
      ],
    });
    render(<FileBrowserPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('src/')).toBeInTheDocument();
    });
    expect(screen.getByText('README.md')).toBeInTheDocument();
  });

  it('calls onNavigate when a directory is clicked', async () => {
    mocks.getFileList.mockResolvedValue({
      path: '.',
      entries: [
        { name: 'src', type: 'dir', size: 4096, modifiedAt: '2024-01-01T00:00:00Z' },
      ],
    });
    render(<FileBrowserPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('src/')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('src/'));
    expect(defaultProps.onNavigate).toHaveBeenCalledWith('src');
  });

  it('calls onSelectFile when a file is clicked', async () => {
    mocks.getFileList.mockResolvedValue({
      path: '.',
      entries: [
        { name: 'main.ts', type: 'file', size: 512, modifiedAt: '2024-01-01T00:00:00Z' },
      ],
    });
    render(<FileBrowserPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('main.ts'));
    expect(defaultProps.onSelectFile).toHaveBeenCalledWith('main.ts');
  });

  it('builds correct paths for nested directories', async () => {
    mocks.getFileList.mockResolvedValue({
      path: 'src/components',
      entries: [
        { name: 'Button.tsx', type: 'file', size: 256, modifiedAt: '2024-01-01T00:00:00Z' },
      ],
    });
    render(<FileBrowserPanel {...defaultProps} initialPath="src/components" />);
    await waitFor(() => {
      expect(screen.getByText('Button.tsx')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Button.tsx'));
    expect(defaultProps.onSelectFile).toHaveBeenCalledWith('src/components/Button.tsx');
  });

  it('shows breadcrumbs for nested path', async () => {
    mocks.getFileList.mockResolvedValue({
      path: 'src/components',
      entries: [],
    });
    render(<FileBrowserPanel {...defaultProps} initialPath="src/components" />);
    await waitFor(() => {
      expect(screen.getByText('/')).toBeInTheDocument();
    });
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('components')).toBeInTheDocument();
  });

  it('navigates to root when / breadcrumb is clicked', async () => {
    mocks.getFileList.mockResolvedValue({
      path: 'src',
      entries: [],
    });
    render(<FileBrowserPanel {...defaultProps} initialPath="src" />);
    await waitFor(() => {
      expect(screen.getByText('/')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('/'));
    expect(defaultProps.onNavigate).toHaveBeenCalledWith('.');
  });

  it('calls onClose when close button is clicked', async () => {
    mocks.getFileList.mockResolvedValue({ path: '.', entries: [] });
    render(<FileBrowserPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('This directory is empty')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText('Close'));
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('calls onClose when Escape key is pressed', async () => {
    mocks.getFileList.mockResolvedValue({ path: '.', entries: [] });
    render(<FileBrowserPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('This directory is empty')).toBeInTheDocument();
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(defaultProps.onClose).toHaveBeenCalled();
  });

  it('shows file sizes', async () => {
    mocks.getFileList.mockResolvedValue({
      path: '.',
      entries: [
        { name: 'big.js', type: 'file', size: 5120, modifiedAt: '2024-01-01T00:00:00Z' },
      ],
    });
    render(<FileBrowserPanel {...defaultProps} />);
    await waitFor(() => {
      expect(screen.getByText('big.js')).toBeInTheDocument();
    });
    expect(screen.getByText('5.0 KB')).toBeInTheDocument();
  });
});
