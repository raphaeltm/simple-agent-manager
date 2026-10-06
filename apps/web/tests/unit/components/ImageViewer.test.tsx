import { act,fireEvent, render, screen } from '@testing-library/react';
import { beforeEach,describe, expect, it, vi } from 'vitest';

import { ImageViewer } from '../../../src/components/shared-file-viewer/ImageViewer';

// Mock the @simple-agent-manager/ui Spinner
vi.mock('@simple-agent-manager/ui', () => ({
  Spinner: ({ size }: { size: string }) => <div data-testid="spinner" data-size={size} />,
}));

describe('ImageViewer', () => {
  const defaultProps = {
    src: 'https://example.com/image.png',
    fileName: 'image.png',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows spinner while loading', () => {
    render(<ImageViewer {...defaultProps} />);
    expect(screen.getByTestId('spinner')).toBeInTheDocument();
  });

  it('renders image with correct src and alt', () => {
    render(<ImageViewer {...defaultProps} />);
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(defaultProps.src);
    expect(img!.getAttribute('alt')).toBe(defaultProps.fileName);
  });

  it('shows dimensions and size toggle after image loads', () => {
    render(<ImageViewer {...defaultProps} />);
    const img = document.querySelector('img')!;

    // Simulate image load with natural dimensions
    Object.defineProperty(img, 'naturalWidth', { value: 1920, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 1080, configurable: true });
    act(() => {
      fireEvent.load(img);
    });

    // Dimensions should be displayed
    expect(screen.getByText(/1920/)).toBeInTheDocument();
    expect(screen.getByText(/1080/)).toBeInTheDocument();

    // Size toggle button should exist
    expect(screen.getByText('Actual size (1:1)')).toBeInTheDocument();
  });

  it('toggles between fit-to-panel and actual-size on button click', () => {
    render(<ImageViewer {...defaultProps} />);
    const img = document.querySelector('img')!;

    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    act(() => {
      fireEvent.load(img);
    });

    // Default: fit to panel
    const toggleBtn = screen.getByText('Actual size (1:1)');
    expect(img.style.transform).toContain('scale(1)');

    // Click to switch to actual size
    act(() => {
      fireEvent.click(toggleBtn);
    });
    expect(img.style.transform).toContain('scale(2)');
    expect(screen.getByText('Fit to panel')).toBeInTheDocument();

    // Click again to switch back
    act(() => {
      fireEvent.click(screen.getByText('Fit to panel'));
    });
    expect(img.style.transform).toContain('scale(1)');
  });

  it('toggles zoom on desktop pointer click', () => {
    render(<ImageViewer {...defaultProps} />);
    const img = document.querySelector('img')!;
    const imageArea = img.parentElement!;

    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    act(() => {
      fireEvent.load(img);
    });

    expect(img.style.transform).toContain('scale(1)');

    act(() => {
      fireEvent.pointerDown(imageArea, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10 });
      fireEvent.pointerUp(imageArea, { pointerId: 1, pointerType: 'mouse', clientX: 10, clientY: 10 });
    });
    expect(img.style.transform).toContain('scale(2)');
  });

  it('double-taps to zoom on touch pointers', () => {
    render(<ImageViewer {...defaultProps} />);
    const img = document.querySelector('img')!;
    const imageArea = img.parentElement!;

    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    act(() => {
      fireEvent.load(img);
    });

    act(() => {
      fireEvent.pointerDown(imageArea, { pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 20 });
      fireEvent.pointerUp(imageArea, { pointerId: 1, pointerType: 'touch', clientX: 20, clientY: 20 });
      fireEvent.pointerDown(imageArea, { pointerId: 2, pointerType: 'touch', clientX: 20, clientY: 20 });
      fireEvent.pointerUp(imageArea, { pointerId: 2, pointerType: 'touch', clientX: 20, clientY: 20 });
    });

    expect(img.style.transform).toContain('scale(2)');
  });

  it('pinch zoom clamps scale to the configured maximum', () => {
    render(<ImageViewer {...defaultProps} />);
    const img = document.querySelector('img')!;
    const imageArea = img.parentElement!;

    Object.defineProperty(img, 'naturalWidth', { value: 800, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 600, configurable: true });
    act(() => {
      fireEvent.load(img);
    });

    act(() => {
      fireEvent.pointerDown(imageArea, { pointerId: 1, pointerType: 'touch', clientX: 0, clientY: 0 });
      fireEvent.pointerDown(imageArea, { pointerId: 2, pointerType: 'touch', clientX: 10, clientY: 0 });
      fireEvent.pointerMove(imageArea, { pointerId: 2, pointerType: 'touch', clientX: 100, clientY: 0 });
    });

    expect(img.style.transform).toContain('scale(4)');
  });

  it('shows error message when image fails to load', () => {
    render(<ImageViewer {...defaultProps} />);
    const img = document.querySelector('img')!;

    act(() => {
      fireEvent.error(img);
    });

    expect(screen.getByText('Failed to load image')).toBeInTheDocument();
  });

  it('shows "Click to load" for files between 10-50 MB', () => {
    render(
      <ImageViewer
        {...defaultProps}
        fileSize={15 * 1024 * 1024} // 15 MB
      />
    );

    expect(screen.getByText('Large image')).toBeInTheDocument();
    expect(screen.getByText('Load preview')).toBeInTheDocument();
    // Image should not be rendered yet
    expect(document.querySelector('img')).toBeNull();
  });

  it('loads image after clicking "Load preview" for large files', () => {
    render(
      <ImageViewer
        {...defaultProps}
        fileSize={15 * 1024 * 1024}
      />
    );

    act(() => {
      fireEvent.click(screen.getByText('Load preview'));
    });

    // Image should now be rendered
    const img = document.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe(defaultProps.src);
  });

  it('shows "Download" for files over 50 MB', () => {
    render(
      <ImageViewer
        {...defaultProps}
        fileSize={60 * 1024 * 1024} // 60 MB
      />
    );

    expect(screen.getByText('File too large to preview')).toBeInTheDocument();
    const downloadLink = screen.getByText('Download');
    expect(downloadLink.tagName).toBe('A');
    expect(downloadLink.getAttribute('href')).toBe(defaultProps.src);
    // No image should be rendered
    expect(document.querySelector('img')).toBeNull();
  });

  it('displays file size in metadata when provided', () => {
    render(
      <ImageViewer
        {...defaultProps}
        fileSize={524288} // 512 KB
      />
    );

    const img = document.querySelector('img')!;
    Object.defineProperty(img, 'naturalWidth', { value: 400, configurable: true });
    Object.defineProperty(img, 'naturalHeight', { value: 300, configurable: true });
    act(() => {
      fireEvent.load(img);
    });

    expect(screen.getByText('512 KB')).toBeInTheDocument();
  });

  it('renders files under 10 MB inline without prompt', () => {
    render(
      <ImageViewer
        {...defaultProps}
        fileSize={5 * 1024 * 1024} // 5 MB
      />
    );

    // Image should be rendered immediately (no "click to load" prompt)
    expect(document.querySelector('img')).not.toBeNull();
    expect(screen.queryByText('Load preview')).toBeNull();
    expect(screen.queryByText('File too large to preview')).toBeNull();
  });
});
