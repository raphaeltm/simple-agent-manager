import { type AdminSettingDefinition, integerDefinition } from './admin-setting-definitions';

/** Whole-file AES-GCM needs plaintext and ciphertext concurrently in a 128 MiB isolate. */
export const LIBRARY_MULTIPART_DEFAULTS = {
  fileMaxBytes: 50 * 1024 * 1024,
  overheadMaxBytes: 64 * 1024,
  maxParts: 16,
  maxHeaderBytes: 8192,
  readTimeoutMs: 120_000,
} as const;
export type LibraryMultipartSettingName = `library.multipart${
  'FileMaxBytes' | 'OverheadMaxBytes' | 'MaxParts' | 'MaxHeaderBytes' | 'ReadTimeoutMs'}`;

export const LIBRARY_MULTIPART_SETTINGS: AdminSettingDefinition[] = [
  integerDefinition(
    'library.multipartFileMaxBytes',
    LIBRARY_MULTIPART_DEFAULTS.fileMaxBytes,
    'Operations',
    'Browser Library upload/replacement file ceiling in bytes, also constrained by LIBRARY_UPLOAD_MAX_BYTES. Maximum 50 MiB preserves memory for unchanged whole-file encryption.',
    { min: 1, max: LIBRARY_MULTIPART_DEFAULTS.fileMaxBytes }
  ),
  integerDefinition(
    'library.multipartOverheadMaxBytes',
    LIBRARY_MULTIPART_DEFAULTS.overheadMaxBytes,
    'Operations',
    'Additional browser multipart wire bytes beyond the file ceiling; also limits aggregate metadata before decoding.',
    { min: 1024, max: 1024 * 1024 }
  ),
  integerDefinition(
    'library.multipartMaxParts',
    LIBRARY_MULTIPART_DEFAULTS.maxParts,
    'Operations',
    'Maximum parts in one browser Library multipart request. One file and optional metadata normally use at most seven.',
    { min: 1, max: 64 }
  ),
  integerDefinition(
    'library.multipartMaxHeaderBytes',
    LIBRARY_MULTIPART_DEFAULTS.maxHeaderBytes,
    'Operations',
    'Maximum header bytes per browser Library multipart part.',
    { min: 256, max: 16 * 1024 }
  ),
  integerDefinition(
    'library.multipartReadTimeoutMs',
    LIBRARY_MULTIPART_DEFAULTS.readTimeoutMs,
    'Operations',
    'Total time to receive and parse a browser Library upload. At 50 MiB the default permits about 427 KiB/s; concurrent materializing writes in an isolate receive 429 and may retry.',
    { min: 1000, max: 600_000 }
  ),
];
