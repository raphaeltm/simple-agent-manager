import { useCallback, useEffect, useRef, useState } from 'react';

export type VoiceState = 'idle' | 'recording' | 'processing' | 'error';

export function useVoiceInput(opts: {
  transcribeUrl: string;
  amplitudeRef: React.MutableRefObject<number>;
  onTranscription: (text: string) => void;
}) {
  const { transcribeUrl, amplitudeRef, onTranscription } = opts;
  const [state, setState] = useState<VoiceState>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (audioCtxRef.current) void audioCtxRef.current.close();
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const startAmplitudeMonitor = useCallback(
    (stream: MediaStream) => {
      try {
        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.6;
        source.connect(analyser);
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);

        const tick = () => {
          analyser.getByteFrequencyData(dataArray);
          let sum = 0;
          for (let i = 0; i < dataArray.length; i++) sum += dataArray[i]!;
          const avg = sum / dataArray.length;
          amplitudeRef.current = Math.min(avg / 128, 1);
          animFrameRef.current = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        // AudioContext not supported
      }
    },
    [amplitudeRef],
  );

  const stopAmplitudeMonitor = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioCtxRef.current) {
      void audioCtxRef.current.close();
      audioCtxRef.current = null;
    }
    analyserRef.current = null;
    amplitudeRef.current = 0;
  }, [amplitudeRef]);

  const stop = useCallback(() => {
    if (mediaRecorderRef.current?.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
    stopAmplitudeMonitor();
  }, [stopAmplitudeMonitor]);

  const start = useCallback(async () => {
    setErrorMsg(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setState('error');
      setErrorMsg('Microphone not supported');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      startAmplitudeMonitor(stream);

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : undefined;

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        if (blob.size === 0) {
          setState('idle');
          return;
        }

        setState('processing');
        try {
          const form = new FormData();
          form.append('audio', blob, 'recording.webm');

          const resp = await fetch(transcribeUrl, {
            method: 'POST',
            credentials: 'include',
            body: form,
          });

          if (!resp.ok) throw new Error(`Transcription failed (${resp.status})`);
          const data = (await resp.json()) as { text: string };
          if (data.text) onTranscription(data.text);
          setState('idle');
        } catch (err) {
          setState('error');
          setErrorMsg(err instanceof Error ? err.message : 'Transcription failed');
          setTimeout(() => setState('idle'), 3000);
        }
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((t) => t.stop());
        stopAmplitudeMonitor();
        setState('error');
        setErrorMsg('Recording failed');
        setTimeout(() => setState('idle'), 3000);
      };

      recorder.start();
      setState('recording');
    } catch (err) {
      stopAmplitudeMonitor();
      setState('error');
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setErrorMsg('Microphone permission denied');
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        setErrorMsg('No microphone found');
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Mic access failed');
      }
      setTimeout(() => setState('idle'), 3000);
    }
  }, [transcribeUrl, onTranscription, startAmplitudeMonitor, stopAmplitudeMonitor]);

  const toggle = useCallback(() => {
    if (state === 'recording') stop();
    else if (state === 'idle') void start();
  }, [state, start, stop]);

  return { state, errorMsg, toggle };
}
