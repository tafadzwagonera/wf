const DEFAULT_RETAINED_BYTES = 64 * 1024;
const TRUNCATION_NOTICE = '[stderr truncated — showing trailing output]\n';

export interface BoundedStderr {
  /** Record a chunk, discarding older bytes once the retention cap is reached. */
  append(chunk: Buffer): void;
  /** Retained tail, prefixed with a notice when earlier bytes were dropped. */
  text(): string;
  /** Bytes observed across the whole run, including bytes that were dropped. */
  totalBytes(): number;
  /** Bytes currently held in memory — never exceeds the cap. */
  retainedBytes(): number;
  isEmpty(): boolean;
}

/**
 * Collects a child process's stderr while holding a bounded amount of it in memory.
 *
 * The previous collector pushed every chunk into a `Buffer[]` that lived for the whole run,
 * then concatenated it — doubling peak usage — only to keep a 2000-character tail for the
 * log or to build an error message. Nothing downstream needs the head, but a chatty child
 * could grow that array without limit, and Buffers sit outside the V8 heap where the
 * `--max-old-space-size` ceiling would not catch it.
 *
 * The full byte count is tracked separately so diagnostics can still report how much stderr
 * a run produced, even though most of it was discarded.
 *
 * @param maxRetainedBytes - Upper bound on bytes held in memory
 * @returns Collector exposing the retained tail and the observed totals
 */
interface StderrState {
  retained: Buffer;
  totalBytes: number;
  dropped: boolean;
}

const appendBounded = (state: StderrState, chunk: Buffer, maxRetainedBytes: number): void => {
  state.totalBytes += chunk.length;
  const combined = Buffer.concat([state.retained, chunk]);
  state.dropped ||= combined.length > maxRetainedBytes;
  state.retained = combined.length <= maxRetainedBytes
    ? combined
    : combined.subarray(combined.length - maxRetainedBytes);
};

const renderText = (state: StderrState): string => {
  const body = state.retained.toString('utf-8');
  return state.dropped ? `${TRUNCATION_NOTICE}${body}` : body;
};

export const createBoundedStderr = (maxRetainedBytes: number = DEFAULT_RETAINED_BYTES): BoundedStderr => {
  const state: StderrState = { retained: Buffer.alloc(0), totalBytes: 0, dropped: false };

  return {
    append: (chunk: Buffer): void => appendBounded(state, chunk, maxRetainedBytes),
    text: (): string => renderText(state),
    totalBytes: (): number => state.totalBytes,
    retainedBytes: (): number => state.retained.length,
    isEmpty: (): boolean => state.totalBytes === 0,
  };
};
