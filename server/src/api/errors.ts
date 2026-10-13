// Consistent error type and response shape: { error: { code, message, details? } }.
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { InvalidWorkflowInputError } from '../orchestrator/supervisor';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string, id: string) => new HttpError(404, 'NOT_FOUND', `${what} ${id} was not found`);
export const conflict = (code: string, message: string, details?: unknown) => new HttpError(409, code, message, details);

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  if (err instanceof InvalidWorkflowInputError) {
    res.status(422).json({ error: { code: 'INVALID_WORKFLOW_INPUT', message: err.message } });
    return;
  }
  if (err instanceof SyntaxError && 'body' in err) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    return;
  }
  // Unexpected: log the detail server-side, return a generic message.
  console.error('Unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
};
