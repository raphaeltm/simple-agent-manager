import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
} from '../routes/mcp/_helpers';

export type OperationErrorCode =
  'invalid_input' | 'not_found' | 'forbidden' | 'conflict' | 'rate_limited' | 'unavailable';

export class OperationError extends Error {
  constructor(
    readonly code: OperationErrorCode,
    message: string,
    readonly hint?: string
  ) {
    super(message);
    this.name = 'OperationError';
  }
}

/** The workspace protocol has historically used INVALID_PARAMS for tool-level failures. */
export function operationErrorToWorkspaceJsonRpc(
  requestId: string | number | null,
  error: OperationError
): JsonRpcResponse {
  return jsonRpcError(
    requestId,
    error.code === 'unavailable' ? INTERNAL_ERROR : INVALID_PARAMS,
    error.message
  );
}

export function operationErrorHttpStatus(error: OperationError): 400 | 403 | 404 | 409 | 429 | 503 {
  switch (error.code) {
    case 'invalid_input':
      return 400;
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'conflict':
      return 409;
    case 'rate_limited':
      return 429;
    case 'unavailable':
      return 503;
  }
}
