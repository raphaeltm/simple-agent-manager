import type { ProjectFile, ProjectFileTag } from '@simple-agent-manager/shared';
import { File as FileIcon,FileCode, FileImage, FileText } from 'lucide-react';

export type ViewMode = 'list' | 'grid';
export type SortOption = 'createdAt' | 'filename' | 'sizeBytes';

export interface FileWithTags extends ProjectFile {
  tags: ProjectFileTag[];
}

export interface UploadItem {
  id: string;
  file: File;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

export const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

export function timeAgo(dateStr: string): string {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function getFileIcon(mimeType: string) {
  if (mimeType.startsWith('image/'))
    return <FileImage size={18} className="text-accent" aria-hidden="true" />;
  if (mimeType.startsWith('text/'))
    return <FileText size={18} className="text-fg-muted" aria-hidden="true" />;
  if (
    mimeType.includes('javascript') ||
    mimeType.includes('json') ||
    mimeType.includes('xml')
  )
    return <FileCode size={18} className="text-fg-muted" aria-hidden="true" />;
  return <FileIcon size={18} className="text-fg-muted" aria-hidden="true" />;
}
