/**
 * MCP tool definitions — project file library tools.
 */

export const LIBRARY_TOOLS = [
  // ─── Project file library tools ──────────────────────────────────────
  {
    name: 'list_library_files',
    description:
      'Browse your project\'s file library. Returns file metadata (not content) so you can decide what to download. ' +
      'Supports filtering by tags, file type (MIME prefix), and upload source.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to files that have ALL specified tags (AND logic)',
        },
        fileType: {
          type: 'string',
          description: 'Filter by MIME type prefix (e.g., "image/", "text/", "application/json")',
        },
        source: {
          type: 'string',
          description: 'Filter by who uploaded the file',
          enum: ['user', 'agent'],
        },
        sortBy: {
          type: 'string',
          description: 'Sort field (default: createdAt)',
          enum: ['createdAt', 'filename', 'sizeBytes'],
        },
        limit: {
          type: 'number',
          description: 'Max files to return (default: 50, max: 200)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'download_library_file',
    description:
      'Download a file from the project library into the workspace. The file is decrypted and placed in the configured library directory ' +
      '(default: .library/, configurable via LIBRARY_MCP_DOWNLOAD_DIR). Use list_library_files first to find the file ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileId: {
          type: 'string',
          description: 'The file ID to download (from list_library_files)',
        },
        targetPath: {
          type: 'string',
          description: 'Custom path within the workspace to place the file (default: .library/<filename>)',
        },
      },
      required: ['fileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'upload_to_library',
    description:
      'Upload a file from the workspace to the project library. The file is encrypted and stored permanently. ' +
      'Fails with FILE_EXISTS error if a file with the same filename already exists — use replace_library_file to update it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file in the workspace to upload',
        },
        description: {
          type: 'string',
          description: 'Optional description of the file contents or purpose',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply to the file (lowercase alphanumeric with hyphens)',
        },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_library_file',
    description:
      'Replace the content of an existing library file with a new version from the workspace. Requires the file ID (not filename). ' +
      'New tags are merged with existing tags. Original upload provenance is preserved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileId: {
          type: 'string',
          description: 'The file ID to replace (from list_library_files or upload_to_library FILE_EXISTS error)',
        },
        filePath: {
          type: 'string',
          description: 'Path to the new file in the workspace',
        },
        description: {
          type: 'string',
          description: 'Optional updated description',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional tags to merge with existing tags',
        },
      },
      required: ['fileId', 'filePath'],
      additionalProperties: false,
    },
  },
];
