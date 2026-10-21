const handlers = new Set<() => void>();

const dispatchSigint = (): void => {
  for (const handler of [...handlers]) handler();
};

/**
 * Registers a SIGINT handler behind a single shared `process` listener.
 *
 * Each concurrent CLI run needs to react to Ctrl-C, but attaching one `process.on('SIGINT')`
 * listener per run trips Node's MaxListenersExceededWarning once more than ten runs are live —
 * routine for fan-out stages like review. The registry keeps exactly one process-level listener
 * installed while any handler is registered and fans the signal out to all of them.
 *
 * @param handler - Invoked when the process receives SIGINT
 * @returns Disposer that unregisters the handler; safe to call more than once
 */
export const registerSigintHandler = (handler: () => void): (() => void) => {
  if (handlers.size === 0) process.on('SIGINT', dispatchSigint);
  handlers.add(handler);
  return () => {
    const removed = handlers.delete(handler);
    if (removed && handlers.size === 0) process.off('SIGINT', dispatchSigint);
  };
};
