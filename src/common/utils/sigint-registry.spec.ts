import { registerSigintHandler } from './sigint-registry';

describe('registerSigintHandler', () => {
  const dispatcherCount = (): number =>
    process.listeners('SIGINT').length;

  it('installs a single process listener regardless of how many handlers register', () => {
    const baseline = dispatcherCount();
    const disposers = Array.from({ length: 25 }, () => registerSigintHandler(jest.fn()));

    expect(dispatcherCount()).toBe(baseline + 1);

    for (const dispose of disposers) dispose();
    expect(dispatcherCount()).toBe(baseline);
  });

  it('invokes every registered handler when SIGINT is dispatched', () => {
    const first = jest.fn();
    const second = jest.fn();
    const disposeFirst = registerSigintHandler(first);
    const disposeSecond = registerSigintHandler(second);

    process.emit('SIGINT');

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    disposeFirst();
    disposeSecond();
  });

  it('stops invoking a handler once its disposer runs', () => {
    const removed = jest.fn();
    const kept = jest.fn();
    const disposeRemoved = registerSigintHandler(removed);
    const disposeKept = registerSigintHandler(kept);

    disposeRemoved();
    process.emit('SIGINT');

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);

    disposeKept();
  });

  it('tolerates a disposer running twice', () => {
    const baseline = dispatcherCount();
    const dispose = registerSigintHandler(jest.fn());
    const disposeOther = registerSigintHandler(jest.fn());

    dispose();
    dispose();

    expect(dispatcherCount()).toBe(baseline + 1);
    disposeOther();
    expect(dispatcherCount()).toBe(baseline);
  });
});
