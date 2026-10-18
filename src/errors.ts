export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: Record<string, string>) =>
  new ApiError(400, 'invalid_request', message, details);
export const notFound = (message = 'Not found.') => new ApiError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);
