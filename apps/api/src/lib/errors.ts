import type { DatabaseError } from 'pg';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, 'bad_request', message, details);
export const unauthorized = (message = 'Sign in required') => new AppError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do this') => new AppError(403, 'forbidden', message);
export const notFound = (what = 'Record') => new AppError(404, 'not_found', `${what} not found`);
export const conflict = (message: string) => new AppError(409, 'conflict', message);
export const rule = (message: string, details?: unknown) => new AppError(422, 'rule', message, details);

/** Map database errors to API errors. Business-rule exceptions raised in SQL use SQLSTATE P0001. */
export function fromDatabase(err: unknown): AppError | null {
  const e = err as Partial<DatabaseError>;
  if (!e || typeof e.code !== 'string') return null;
  switch (e.code) {
    case 'P0001':
      return rule(e.message ?? 'Rule violated');
    case 'P0002':
      return notFound();
    case '23505':
      return conflict(uniqueMessage(e.constraint));
    case '23514':
      return rule(`A value is outside the allowed range (${e.constraint ?? 'check'})`);
    case '23503':
      return rule('A referenced record does not exist');
    case '42501':
      return forbidden();
    default:
      return null;
  }
}

function uniqueMessage(constraint?: string): string {
  if (!constraint) return 'This record already exists';
  if (constraint.includes('cheque')) return 'This cheque number has already been recorded';
  if (constraint.includes('gate_pass')) return 'This gate pass number has already been used';
  if (constraint.includes('username')) return 'This username is taken';
  if (constraint.includes('code')) return 'This code is already in use';
  return 'This record already exists';
}
