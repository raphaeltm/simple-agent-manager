import type {
  FileStatus,
  FileTagSource,
  FileUploadSource,
  ProjectFile,
  ProjectFileTag,
} from '@simple-agent-manager/shared';

import type * as schema from '../db/schema';

export function rowToProjectFile(row: schema.ProjectFileRow): ProjectFile {
  return {
    id: row.id,
    projectId: row.projectId,
    filename: row.filename,
    directory: row.directory,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    description: row.description,
    uploadedBy: row.uploadedBy,
    uploadSource: row.uploadSource as FileUploadSource,
    uploadSessionId: row.uploadSessionId,
    uploadTaskId: row.uploadTaskId,
    replacedAt: row.replacedAt,
    replacedBy: row.replacedBy,
    status: row.status as FileStatus,
    extractedTextPreview: row.extractedTextPreview,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function rowToTag(row: schema.ProjectFileTagRow): ProjectFileTag {
  return {
    fileId: row.fileId,
    tag: row.tag,
    tagSource: row.tagSource as FileTagSource,
  };
}
