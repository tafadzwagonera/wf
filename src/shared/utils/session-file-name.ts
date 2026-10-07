import { ValidationError } from '../errors/app.error';
import type { SessionState } from '../types/session.types';

const DATE_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}-/;

export const buildSessionFileName = (
  state: Pick<SessionState, 'ticketKey' | 'sessionId' | 'createdAt'>
): string => {
  if (DATE_PREFIX_PATTERN.test(state.ticketKey)) return `${state.ticketKey}-${state.sessionId}.json`;
  const created = new Date(state.createdAt);
  if (Number.isNaN(created.getTime())) {
    throw new ValidationError(`Invalid createdAt for session file name: ${state.createdAt}`);
  }
  return `${created.toISOString().slice(0, 10)}-${state.ticketKey}-${state.sessionId}.json`;
};

export const stripSessionDatePrefix = (fileName: string): string =>
  fileName.replace(DATE_PREFIX_PATTERN, '');
