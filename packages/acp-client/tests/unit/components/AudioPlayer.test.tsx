import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AudioPlayer } from '../../../src/components/AudioPlayer';

describe('AudioPlayer', () => {
  const defaultProps = {
    state: 'playing' as const,
    currentTime: 30,
    duration: 120,
    playbackRate: 1,
    onToggle: vi.fn(),
    onStop: vi.fn(),
    onSeek: vi.fn(),
    onSkipForward: vi.fn(),
    onSkipBackward: vi.fn(),
    onPlaybackRateChange: vi.fn(),
  };

  it('renders audio player region', () => {
    render(<AudioPlayer {...defaultProps} />);
    expect(screen.getByRole('region', { name: 'Audio player' })).toBeTruthy();
  });

  it('shows pause button when playing', () => {
    render(<AudioPlayer {...defaultProps} />);
    expect(screen.getByLabelText('Pause')).toBeTruthy();
  });

  it('shows play button when paused', () => {
    render(<AudioPlayer {...defaultProps} state="paused" />);
    expect(screen.getByLabelText('Play')).toBeTruthy();
  });

  it('shows spinner when loading', () => {
    render(<AudioPlayer {...defaultProps} state="loading" />);
    expect(screen.getByLabelText('Cancel audio generation')).toBeTruthy();
  });

  it('calls onToggle when play/pause button is clicked', () => {
    const onToggle = vi.fn();
    render(<AudioPlayer {...defaultProps} onToggle={onToggle} />);

    fireEvent.click(screen.getByLabelText('Pause'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('calls onStop when close button is clicked', () => {
    const onStop = vi.fn();
    render(<AudioPlayer {...defaultProps} onStop={onStop} />);

    fireEvent.click(screen.getByLabelText('Close player'));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('calls onSkipBackward with 10 seconds when skip back is clicked', () => {
    const onSkipBackward = vi.fn();
    render(<AudioPlayer {...defaultProps} onSkipBackward={onSkipBackward} />);

    fireEvent.click(screen.getByLabelText('Skip back 10 seconds'));
    expect(onSkipBackward).toHaveBeenCalledWith(10);
  });

  it('calls onSkipForward with 10 seconds when skip forward is clicked', () => {
    const onSkipForward = vi.fn();
    render(<AudioPlayer {...defaultProps} onSkipForward={onSkipForward} />);

    fireEvent.click(screen.getByLabelText('Skip forward 10 seconds'));
    expect(onSkipForward).toHaveBeenCalledWith(10);
  });

  it('renders seek bar when playing', () => {
    render(<AudioPlayer {...defaultProps} />);
    expect(screen.getByLabelText('Seek position')).toBeTruthy();
  });

  it('renders seek bar when paused', () => {
    render(<AudioPlayer {...defaultProps} state="paused" />);
    expect(screen.getByLabelText('Seek position')).toBeTruthy();
  });

  it('does not render seek bar when loading', () => {
    render(<AudioPlayer {...defaultProps} state="loading" />);
    expect(screen.queryByLabelText('Seek position')).toBeNull();
  });

  it('calls onSeek when seek bar changes', () => {
    const onSeek = vi.fn();
    render(<AudioPlayer {...defaultProps} onSeek={onSeek} />);

    fireEvent.change(screen.getByLabelText('Seek position'), { target: { value: '60' } });
    expect(onSeek).toHaveBeenCalledWith(60);
  });

  it('displays formatted time', () => {
    render(<AudioPlayer {...defaultProps} currentTime={65} duration={185} />);
    // 65s = 1:05, 185s = 3:05
    expect(screen.getByText('1:05')).toBeTruthy();
    expect(screen.getByText('3:05')).toBeTruthy();
  });

  it('renders speed selector with all options', () => {
    render(<AudioPlayer {...defaultProps} />);
    const select = screen.getByLabelText('Playback speed');
    const options = select.querySelectorAll('option');
    expect(options.length).toBe(6);
    expect(Array.from(options).map((o) => o.textContent)).toEqual([
      '0.5x', '0.75x', '1x', '1.25x', '1.5x', '2x',
    ]);
  });

  it('calls onPlaybackRateChange when speed is changed', () => {
    const onPlaybackRateChange = vi.fn();
    render(<AudioPlayer {...defaultProps} onPlaybackRateChange={onPlaybackRateChange} />);

    fireEvent.change(screen.getByLabelText('Playback speed'), { target: { value: '1.5' } });
    expect(onPlaybackRateChange).toHaveBeenCalledWith(1.5);
  });

  it('disables skip buttons when loading', () => {
    render(<AudioPlayer {...defaultProps} state="loading" />);

    const skipBack = screen.getByLabelText('Skip back 10 seconds');
    const skipForward = screen.getByLabelText('Skip forward 10 seconds');
    expect(skipBack).toHaveProperty('disabled', true);
    expect(skipForward).toHaveProperty('disabled', true);
  });

  it('formats hours correctly for long audio', () => {
    render(<AudioPlayer {...defaultProps} currentTime={3661} duration={7200} />);
    // 3661s = 1:01:01
    expect(screen.getByText('1:01:01')).toBeTruthy();
    // 7200s = 2:00:00
    expect(screen.getByText('2:00:00')).toBeTruthy();
  });
});
