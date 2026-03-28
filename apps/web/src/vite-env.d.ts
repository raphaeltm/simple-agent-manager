/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_FILE_PREVIEW_INLINE_MAX_BYTES?: string;
  readonly VITE_FILE_PREVIEW_LOAD_MAX_BYTES?: string;
  readonly DEV: boolean;
  readonly PROD: boolean;
  readonly MODE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
