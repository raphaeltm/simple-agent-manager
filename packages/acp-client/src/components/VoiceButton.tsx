import { useState, useRef, useCallback, useEffect } from 'react';

/** VoiceButton states */
type VoiceState = 'idle' | 'recording' | 'processing' | 'error';

export interface VoiceButtonProps {
  /** Called with transcribed text when transcription completes */
  onTranscription: (text: string) => void;
  /** Disable the button (e.g., when agent is not ready) */
  disabled?: boolean;
  /** Full URL for the transcription endpoint (e.g., https://api.example.com/api/transcribe) */
  apiUrl: string;
  /** Optional callback for reporting errors to telemetry */
  onError?: (info: { message: string; source: string; context?: Record<string, unknown> }) => void;
}

/** Inline SVG microphone icon (idle state) */
function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

/** Inline SVG stop/square icon (recording state) */
function StopIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      className={className}
      aria-hidden="true"
    >
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  );
}

/** Small spinner for processing state */
function Spinner({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

/**
 * VoiceButton — captures microphone audio, sends to transcription API,
 * and returns transcribed text via callback.
 *
 * States: idle -> recording -> processing -> idle (or error -> idle)
 * Toggle interaction: click to start, click to stop.
 */
export function VoiceButton({ onTranscription, disabled = false, apiUrl, onError }: VoiceButtonProps) {
  const [state, setState] = useState<VoiceState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [amplitude, setAmplitude] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioContextRef.current) {
        void audioContextRef.current.close();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  /** Start monitoring audio amplitude via AnalyserNode */
  const startAmplitudeMonitor = useCallback((stream: MediaStream) => {
    try {
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);

      const tick = () => {
        analyser.getByteFrequencyData(dataArray);
        // Compute average amplitude (0-255), normalize to 0-1
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i]!;
        }
        const avg = sum / dataArray.length;
        setAmplitude(Math.min(avg / 128, 1)); // 0-1 range, capped
        animationFrameRef.current = requestAnimationFrame(tick);
      };

      tick();
    } catch {
      // AudioContext not supported — fall back to no amplitude visualization
    }
  }, []);

  /** Stop amplitude monitoring */
  const stopAmplitudeMonitor = useCallback(() => {
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    setAmplitude(0);
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    stopAmplitudeMonitor();
  }, [stopAmplitudeMonitor]);

  const startRecording = useCallback(async () => {
    setErrorMessage(null);

    // Check for browser support
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setState('error');
      setErrorMessage('Microphone not supported in this browser');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Start amplitude monitoring for visual feedback
      startAmplitudeMonitor(stream);

      // Determine supported MIME type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : undefined;

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        // Stop all tracks to release the microphone
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;

        const audioBlob = new Blob(audioChunksRef.current, {
          type: recorder.mimeType || 'audio/webm',
        });

        if (audioBlob.size === 0) {
          setState('idle');
          return;
        }

        // Send audio to transcription API
        setState('processing');
        try {
          const formData = new FormData();
          formData.append('audio', audioBlob, 'recording.webm');

          const response = await fetch(apiUrl, {
            method: 'POST',
            credentials: 'include',
            body: formData,
          });

          if (!response.ok) {
            const errorText = await response.text().catch(() => '');
            let message = `Transcription failed (${response.status})`;
            try {
              const errorData = JSON.parse(errorText) as { message?: string };
              if (errorData.message) message = errorData.message;
            } catch {
              if (errorText) message = errorText;
            }
            throw new Error(message);
          }

          const data = (await response.json()) as { text: string };
          if (data.text) {
            onTranscription(data.text);
          }
          setState('idle');
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Transcription failed';
          setState('error');
          setErrorMessage(msg);
          onError?.({ message: msg, source: 'VoiceButton', context: { phase: 'transcription' } });
          // Auto-recover to idle after a brief delay
          setTimeout(() => setState('idle'), 3000);
        }
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        stopAmplitudeMonitor();
        setState('error');
        setErrorMessage('Recording failed');
        onError?.({ message: 'Recording failed', source: 'VoiceButton', context: { phase: 'recording' } });
        setTimeout(() => setState('idle'), 3000);
      };

      recorder.start();
      setState('recording');
    } catch (err) {
      stopAmplitudeMonitor();
      setState('error');
      let msg: string;
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        msg = 'Microphone permission denied';
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        msg = 'No microphone found';
      } else {
        msg = err instanceof Error ? err.message : 'Failed to access microphone';
      }
      setErrorMessage(msg);
      onError?.({
        message: msg,
        source: 'VoiceButton',
        context: {
          phase: 'mic-access',
          errorName: err instanceof DOMException ? err.name : undefined,
        },
      });
      // Auto-recover to idle after a brief delay
      setTimeout(() => setState('idle'), 3000);
    }
  }, [apiUrl, onTranscription, onError, startAmplitudeMonitor, stopAmplitudeMonitor]);

  const handleClick = useCallback(() => {
    if (state === 'recording') {
      stopRecording();
    } else if (state === 'idle') {
      void startRecording();
    }
    // Ignore clicks during processing or error states
  }, [state, startRecording, stopRecording]);

  const isDisabled = disabled || state === 'processing';

  // Determine button styling based on state
  let buttonClasses =
    'relative flex items-center justify-center rounded-full text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1';
  let title = 'Voice input';

  switch (state) {
    case 'idle':
      buttonClasses += ' text-gray-500 hover:text-gray-700 hover:bg-gray-100';
      title = 'Start voice input';
      break;
    case 'recording':
      buttonClasses += ' text-red-600 bg-red-50 hover:bg-red-100 focus:ring-red-500';
      title = 'Stop recording';
      break;
    case 'processing':
      buttonClasses += ' text-blue-500 bg-blue-50 cursor-wait';
      title = 'Transcribing...';
      break;
    case 'error':
      buttonClasses += ' text-orange-500 bg-orange-50';
      title = errorMessage || 'Error';
      break;
  }

  if (isDisabled && state !== 'processing') {
    buttonClasses += ' opacity-50 cursor-not-allowed';
  }

  // Glow size scales with amplitude: base 4px + up to 16px more
  const glowSize = 4 + amplitude * 16;
  // Glow opacity scales with amplitude: 0.3 base + up to 0.6 more
  const glowOpacity = 0.3 + amplitude * 0.6;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isDisabled}
      className={buttonClasses}
      style={{
        minWidth: 44,
        minHeight: 44,
        boxShadow:
          state === 'recording'
            ? `0 0 ${glowSize}px ${glowSize / 2}px rgba(239, 68, 68, ${glowOpacity})`
            : undefined,
        transition: 'box-shadow 0.1s ease-out, background-color 0.15s ease',
      }}
      title={title}
      aria-label={title}
      data-amplitude={state === 'recording' ? amplitude.toFixed(2) : undefined}
    >
      {state === 'recording' && <StopIcon />}
      {state === 'processing' && (
        <Spinner className="animate-spin" />
      )}
      {(state === 'idle' || state === 'error') && (
        <MicIcon />
      )}
    </button>
  );
}
