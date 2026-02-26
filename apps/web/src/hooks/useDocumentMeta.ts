import { useEffect } from 'react';

interface DocumentMeta {
  title: string;
  description?: string;
}

/**
 * Minimal hook to set document title and meta description.
 * Restores previous title on unmount.
 */
export function useDocumentMeta({ title, description }: DocumentMeta) {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = title;

    let metaEl = document.querySelector('meta[name="description"]') as HTMLMetaElement | null;
    const prevDescription = metaEl?.content ?? '';

    if (description) {
      if (!metaEl) {
        metaEl = document.createElement('meta');
        metaEl.name = 'description';
        document.head.appendChild(metaEl);
      }
      metaEl.content = description;
    }

    return () => {
      document.title = prevTitle;
      if (metaEl) metaEl.content = prevDescription;
    };
  }, [title, description]);
}
