import { lazyModuleKey, registerLazyModule, requireLazyModule } from './lazy-module';

describe('requireLazyModule', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns the registered module without calling the disk loader', () => {
    const mockLoadFromDisk = jest.fn();
    const registered = { name: 'registered' };
    registerLazyModule(lazyModuleKey.appModule, registered);

    const result = requireLazyModule(lazyModuleKey.appModule, mockLoadFromDisk);

    expect(result).toBe(registered);
    expect(mockLoadFromDisk).not.toHaveBeenCalled();
  });

  it('falls back to the disk loader when nothing is registered', () => {
    const mockLoadFromDisk = jest.fn().mockReturnValue({ name: 'disk' });

    const result = requireLazyModule(lazyModuleKey.jiti, mockLoadFromDisk);

    expect(result).toEqual({ name: 'disk' });
    expect(mockLoadFromDisk).toHaveBeenCalledTimes(1);
  });
});
