/**
 * Utility functions for creating standardized API responses
 */

export interface ApiResponse<T = any> {
  statusCode: number;
  body: string;
  headers?: { [key: string]: string };
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}

export function createSuccessResponse<T>(
  data: T,
  statusCode: number = 200,
  message?: string
): ApiResponse<SuccessResponse<T>> {
  const response: SuccessResponse<T> = {
    success: true,
    data,
    ...(message && { message }),
  };

  return {
    statusCode,
    body: JSON.stringify(response),
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

export function createErrorResponse(
  code: string,
  message: string,
  statusCode: number = 400,
  details?: any
): ApiResponse<ErrorResponse> {
  const response: ErrorResponse = {
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
  };

  return {
    statusCode,
    body: JSON.stringify(response),
    headers: {
      'Content-Type': 'application/json',
    },
  };
}
