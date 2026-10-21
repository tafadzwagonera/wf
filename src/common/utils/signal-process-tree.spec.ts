import type { ChildProcess } from 'child_process';
import { signalProcessTree } from './signal-process-tree';

const createMockChild = (pid: number | undefined) =>
  ({ pid, kill: jest.fn() }) as unknown as ChildProcess & { kill: jest.Mock };

describe('signalProcessTree', () => {
  let mockProcessKill: jest.SpyInstance;

  beforeEach(() => {
    mockProcessKill = jest.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    mockProcessKill.mockRestore();
  });

  it('signals the negated pid so every descendant of the child is reached', () => {
    const child = createMockChild(4321);

    signalProcessTree(child, 'SIGTERM');

    expect(mockProcessKill).toHaveBeenCalledWith(-4321, 'SIGTERM');
  });

  it('also signals the child directly so its exit bookkeeping stays accurate', () => {
    const child = createMockChild(4321);

    signalProcessTree(child, 'SIGKILL');

    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('still terminates the child when the group is already reaped', () => {
    const child = createMockChild(4321);
    mockProcessKill.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    expect(() => signalProcessTree(child, 'SIGTERM')).not.toThrow();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('signals only the child when the spawn never produced a pid', () => {
    const child = createMockChild(undefined);

    signalProcessTree(child, 'SIGTERM');

    expect(mockProcessKill).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});
