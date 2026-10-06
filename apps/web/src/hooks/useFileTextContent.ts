import { useEffect, useState } from 'react';

/** Default timeout for fetching a previewable file's text content (ms). */
const DEFAULT_FILE_TEXT_FETCH_TIMEOUT_MS = 30_000;
const FILE_TEXT_FETCH_TIMEOUT_MS = import.meta.env.VITE_FILE_TEXT_FETCH_TIMEOUT_MS
  ? parseInt(import.meta.env.VITE_FILE_TEXT_FETCH_TIMEOUT_MS, 10)
  : DEFAULT_FILE_TEXT_FETCH_TIMEOUT_MS;

export interface FileTextContent {
  content: string | null;
  loading: boolean;
  error: string | null;
}

/**
 * Fetches a library file's text from the authenticated preview endpoint.
 *
 * Shared by the markdown branch and the HTML source view, which previously carried two
 * near-identical copies of this effect. `enabled` lets a caller defer the request until the content
 * is actually needed — the HTML source view only fetches when the user switches to it, so opening an
 * HTML artifact costs one request (the preview-URL mint) rather than two.
 */
export function useFileTextContent(previewUrl: string, enabled: boolean): FileTextContent {
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FILE_TEXT_FETCH_TIMEOUT_MS);
    setLoading(true);
    setError(null);

    fetch(previewUrl, { credentials: 'include', signal: controller.signal })
      .then((resp) => {
        if (!resp.ok) throw new Error(`Failed to load file (${resp.status})`);
        return resp.text();
      })
      .then((text) => {
        if (!controller.signal.aborted) {
          setContent(text);
          setLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) {
          setError(err.name === 'AbortError' ? 'Request timed out' : err.message);
          setLoading(false);
        }
      })
      .finally(() => clearTimeout(timer));

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [enabled, previewUrl]);

  return { content, loading, error };
}
