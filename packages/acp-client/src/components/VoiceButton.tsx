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
export function VoiceButton({ onTranscription, disabled = false, apiUrl }: VoiceButtonProps) {
  const [state, setState] = useState<VoiceState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
      }
    };
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

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
            const errorData = await response.json().catch(() => null);
            const message =
              (errorData as { message?: string })?.message ||
              `Transcription failed (${response.status})`;
            throw new Error(message);
          }

          const data = (await response.json()) as { text: string };
          if (data.text) {
            onTranscription(data.text);
          }
          setState('idle');
        } catch (err) {
          setState('error');
          setErrorMessage(
            err instanceof Error ? err.message : 'Transcription failed'
          );
          // Auto-recover to idle after a brief delay
          setTimeout(() => setState('idle'), 3000);
        }
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setState('error');
        setErrorMessage('Recording failed');
        setTimeout(() => setState('idle'), 3000);
      };

      recorder.start();
      setState('recording');
    } catch (err) {
      setState('error');
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setErrorMessage('Microphone permission denied');
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        setErrorMessage('No microphone found');
      } else {
        setErrorMessage(
          err instanceof Error ? err.message : 'Failed to access microphone'
        );
      }
      // Auto-recover to idle after a brief delay
      setTimeout(() => setState('idle'), 3000);
    }
  }, [apiUrl, onTranscription]);

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
    'relative flex items-center justify-center rounded-md text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1';
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

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={isDisabled}
      className={buttonClasses}
      style={{ minWidth: 44, minHeight: 44 }}
      title={title}
      aria-label={title}
    >
      {state === 'recording' && (
        <>
          {/* Pulsing recording indicator */}
          <span
            className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500"
            style={{ animation: 'pulse 1.5s ease-in-out infinite' }}
          />
          <StopIcon />
        </>
      )}
      {state === 'processing' && (
        <Spinner className="animate-spin" />
      )}
      {(state === 'idle' || state === 'error') && (
        <MicIcon />
      )}
      {/* CSS animation for pulsing dot (injected inline for package portability) */}
      {state === 'recording' && (
        <style>{`
          @keyframes pulse {
            0%, 100% { opacity: 1; transform: scale(1); }
            50% { opacity: 0.5; transform: scale(1.3); }
          }
        `}</style>
      )}
    </button>
  );
}
