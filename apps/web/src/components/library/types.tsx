import type { ProjectFile, ProjectFileTag } from '@simple-agent-manager/shared';
import { resolveEffectiveMimeType } from '@simple-agent-manager/shared';
import { File as FileIcon,FileCode, FileImage, FileText } from 'lucide-react';

export { timeAgo } from '../../lib/time-utils';

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

export function getFileIcon(mimeType: string, filename?: string) {
  // Resolve the effective type so an octet-stream/empty stored type (agent
  // uploads) still gets the right icon from the filename extension, matching the
  // preview tier the file now renders in.
  const effective = resolveEffectiveMimeType(mimeType, filename);
  if (effective.startsWith('image/'))
    return <FileImage size={18} className="text-accent" aria-hidden="true" />;
  if (effective.startsWith('text/'))
    return <FileText size={18} className="text-fg-muted" aria-hidden="true" />;
  if (
    effective.includes('javascript') ||
    effective.includes('json') ||
    effective.includes('xml')
  )
    return <FileCode size={18} className="text-fg-muted" aria-hidden="true" />;
  return <FileIcon size={18} className="text-fg-muted" aria-hidden="true" />;
}
