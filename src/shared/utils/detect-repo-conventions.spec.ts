import * as fs from 'fs';
import * as path from 'path';
import {
  detectRepoConventions,
  formatRepoConventionsPromptSection,
  RepoConventionsContext,
} from './detect-repo-conventions';

jest.mock('fs');

const REPO_DIR = '/fake/repo';
const SRC_DIR = path.join(REPO_DIR, 'src');

const mockExistsSync = fs.existsSync as jest.MockedFunction<
  typeof fs.existsSync
>;
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<
  typeof fs.readFileSync
>;
// Cast as jest.Mock to avoid TypeScript overload resolution conflicts with readdirSync signatures
const mockReaddirSync = fs.readdirSync as jest.Mock;

// --- Factories ---

const createMockPackageJson = (
  overrides: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    name: 'fake-repo',
    dependencies: { '@nestjs/core': '^10.0.0', express: '^4.0.0' },
    devDependencies: { jest: '^29.0.0' },
    ...overrides,
  });

const createMockTsConfig = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    compilerOptions: {
      strict: true,
      module: 'commonjs',
      target: 'ES2021',
      paths: { '@app/*': ['src/*'] },
      ...overrides,
    },
  });

const createMockEslintRc = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    rules: {
      semi: ['error', 'always'],
      quotes: ['error', 'single'],
      'comma-dangle': ['error', 'always-multiline'],
      ...overrides,
    },
  });

const createMockEmptyContext = (): RepoConventionsContext => ({
  linter: null,
  typescript: null,
  folderStructure: [],
  namingPattern: 'mixed',
  nestjsDetected: false,
  importStyle: 'unknown',
  keyDependencies: [],
  errorHandlingPaths: [],
});

describe('detectRepoConventions', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('when all config files are present', () => {
    it('returns full detection with eslint, tsconfig, nestjs, and error paths', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return (
          s === path.join(REPO_DIR, '.eslintrc.json') ||
          s === path.join(REPO_DIR, 'tsconfig.json') ||
          s === path.join(REPO_DIR, 'package.json') ||
          s === SRC_DIR
        );
      });

      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        const s = String(p);
        if (s === path.join(REPO_DIR, '.eslintrc.json'))
          return createMockEslintRc();
        if (s === path.join(REPO_DIR, 'tsconfig.json'))
          return createMockTsConfig();
        if (s === path.join(REPO_DIR, 'package.json'))
          return createMockPackageJson();
        return '{}';
      });

      const mockAgentsDir = {
        name: 'agents',
        isDirectory: () => true,
      } as fs.Dirent;
      const mockCommandsDir = {
        name: 'commands',
        isDirectory: () => true,
      } as fs.Dirent;
      const mockErrorFile = {
        name: 'error-handler.ts',
        isDirectory: () => false,
      } as fs.Dirent;

      mockReaddirSync.mockImplementation((dir: fs.PathLike) => {
        const s = String(dir);
        if (s === SRC_DIR)
          return [mockAgentsDir, mockCommandsDir, mockErrorFile] as fs.Dirent[];
        return [] as fs.Dirent[];
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.linter).not.toBeNull();
      expect(result.linter?.tool).toBe('eslint');
      expect(result.linter?.keyRules['semi']).toBeDefined();
      expect(result.typescript).not.toBeNull();
      expect(result.typescript?.strict).toBe(true);
      expect(result.typescript?.module).toBe('commonjs');
      expect(result.typescript?.target).toBe('ES2021');
      expect(result.folderStructure).toEqual(['agents', 'commands']);
      expect(result.nestjsDetected).toBe(true);
      expect(result.importStyle).toBe('commonjs');
      expect(result.keyDependencies).toContain('@nestjs/core');
      expect(result.keyDependencies).toContain('jest');
      expect(result.errorHandlingPaths.length).toBeGreaterThan(0);
    });
  });

  describe('when config files are missing', () => {
    it('returns null for linter and typescript, and empty arrays for others', () => {
      mockExistsSync.mockReturnValue(false);

      const result = detectRepoConventions(REPO_DIR);

      expect(result.linter).toBeNull();
      expect(result.typescript).toBeNull();
      expect(result.folderStructure).toEqual([]);
      expect(result.keyDependencies).toEqual([]);
      expect(result.errorHandlingPaths).toEqual([]);
      expect(result.nestjsDetected).toBe(false);
    });

    it('never throws even when readFileSync throws', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error('disk error');
      });
      mockReaddirSync.mockReturnValue([]);

      expect(() => detectRepoConventions(REPO_DIR)).not.toThrow();
    });
  });

  describe('naming pattern classification', () => {
    const makeFileEntry = (name: string): fs.Dirent =>
      ({ name, isDirectory: () => false }) as fs.Dirent;

    beforeEach(() => {
      mockExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === SRC_DIR,
      );
    });

    it('detects camelCase when most files use camelCase', () => {
      mockReaddirSync.mockReturnValue([
        makeFileEntry('myService.ts'),
        makeFileEntry('userHelper.ts'),
        makeFileEntry('authUtils.ts'),
      ] as fs.Dirent[]);

      const result = detectRepoConventions(REPO_DIR);
      expect(result.namingPattern).toBe('camelCase');
    });

    it('detects kebab-case when most files use kebab-case', () => {
      mockReaddirSync.mockReturnValue([
        makeFileEntry('my-service.ts'),
        makeFileEntry('user-helper.ts'),
        makeFileEntry('auth-utils.ts'),
      ] as fs.Dirent[]);

      const result = detectRepoConventions(REPO_DIR);
      expect(result.namingPattern).toBe('kebab-case');
    });

    it('detects PascalCase when most files use PascalCase', () => {
      mockReaddirSync.mockReturnValue([
        makeFileEntry('MyService.ts'),
        makeFileEntry('UserHelper.ts'),
        makeFileEntry('AuthUtils.ts'),
      ] as fs.Dirent[]);

      const result = detectRepoConventions(REPO_DIR);
      expect(result.namingPattern).toBe('PascalCase');
    });

    it('returns mixed when files use a mix of conventions', () => {
      mockReaddirSync.mockReturnValue([
        makeFileEntry('myService.ts'),
        makeFileEntry('user-helper.ts'),
        makeFileEntry('AuthUtils.ts'),
        makeFileEntry('another-thing.ts'),
      ] as fs.Dirent[]);

      const result = detectRepoConventions(REPO_DIR);
      expect(result.namingPattern).toBe('mixed');
    });
  });

  describe('NestJS detection', () => {
    it('sets nestjsDetected to true when @nestjs/core is in dependencies', () => {
      mockExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'package.json'),
      );
      mockReadFileSync.mockReturnValue(
        createMockPackageJson({
          dependencies: { '@nestjs/core': '^10.0.0' },
          devDependencies: {},
        }),
      );

      const result = detectRepoConventions(REPO_DIR);
      expect(result.nestjsDetected).toBe(true);
    });

    it('sets nestjsDetected to false when @nestjs/core is absent', () => {
      mockExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'package.json'),
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          dependencies: { express: '^4.0.0' },
          devDependencies: {},
        }),
      );

      const result = detectRepoConventions(REPO_DIR);
      expect(result.nestjsDetected).toBe(false);
    });
  });

  describe('import style detection', () => {
    it('returns commonjs when tsconfig module is commonjs', () => {
      mockExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'tsconfig.json'),
      );
      mockReadFileSync.mockReturnValue(
        createMockTsConfig({ module: 'commonjs' }),
      );

      const result = detectRepoConventions(REPO_DIR);
      expect(result.importStyle).toBe('commonjs');
    });

    it('returns esm when tsconfig module is ESNext', () => {
      mockExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'tsconfig.json'),
      );
      mockReadFileSync.mockReturnValue(
        createMockTsConfig({ module: 'ESNext' }),
      );

      const result = detectRepoConventions(REPO_DIR);
      expect(result.importStyle).toBe('esm');
    });

    it('returns esm when package.json type is module', () => {
      mockExistsSync.mockImplementation(
        (p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'package.json'),
      );
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          type: 'module',
          dependencies: {},
          devDependencies: {},
        }),
      );

      const result = detectRepoConventions(REPO_DIR);
      expect(result.importStyle).toBe('esm');
    });

    it('returns unknown when no module info is found', () => {
      mockExistsSync.mockReturnValue(false);

      const result = detectRepoConventions(REPO_DIR);
      expect(result.importStyle).toBe('unknown');
    });
  });

  describe('error handling paths', () => {
    it('finds error files recursively in src/', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s === SRC_DIR || s === path.join(SRC_DIR, 'shared');
      });

      const mockSharedDir = {
        name: 'shared',
        isDirectory: () => true,
      } as fs.Dirent;
      const mockErrorFile = {
        name: 'errors.ts',
        isDirectory: () => false,
      } as fs.Dirent;
      const mockExceptionFilter = {
        name: 'exception.filter.ts',
        isDirectory: () => false,
      } as fs.Dirent;

      mockReaddirSync.mockImplementation((dir: fs.PathLike) => {
        const s = String(dir);
        if (s === SRC_DIR) return [mockSharedDir] as fs.Dirent[];
        if (s === path.join(SRC_DIR, 'shared'))
          return [mockErrorFile, mockExceptionFilter] as fs.Dirent[];
        return [] as fs.Dirent[];
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.errorHandlingPaths).toHaveLength(2);
      expect(
        result.errorHandlingPaths.some((p) => p.includes('errors.ts')),
      ).toBe(true);
      expect(
        result.errorHandlingPaths.some((p) =>
          p.includes('exception.filter.ts'),
        ),
      ).toBe(true);
    });
  });
});

describe('formatRepoConventionsPromptSection', () => {
  describe('when context has no meaningful data', () => {
    it('returns empty string for default/empty context', () => {
      const ctx = createMockEmptyContext();
      const result = formatRepoConventionsPromptSection(ctx, 'my-repo');
      expect(result).toBe('');
    });
  });

  describe('when context has meaningful data', () => {
    it('produces a formatted section with all populated fields', () => {
      const ctx: RepoConventionsContext = {
        linter: { tool: 'eslint', keyRules: { semi: true, singleQuote: true } },
        typescript: {
          strict: true,
          module: 'commonjs',
          target: 'ES2021',
          paths: {},
        },
        folderStructure: ['agents', 'commands', 'integrations', 'shared'],
        namingPattern: 'kebab-case',
        nestjsDetected: true,
        importStyle: 'commonjs',
        keyDependencies: ['@nestjs/core', 'jest'],
        errorHandlingPaths: ['src/shared/utils/errors.ts'],
      };

      const result = formatRepoConventionsPromptSection(ctx, 'repoName');

      expect(result).toContain('Repository conventions (repoName):');
      expect(result).toContain('Linter: eslint');
      expect(result).toContain('semi');
      expect(result).toContain('TypeScript: strict mode, commonjs, ES2021');
      expect(result).toContain(
        'Folder structure: agents, commands, integrations, shared',
      );
      expect(result).toContain('Naming: kebab-case');
      expect(result).toContain('Framework: NestJS');
      expect(result).toContain('Import style: commonjs');
      expect(result).toContain('Key deps: @nestjs/core, jest');
      expect(result).toContain('Error utilities: src/shared/utils/errors.ts');
    });

    it('includes linter section with prettier tool', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        linter: {
          tool: 'prettier',
          keyRules: { semi: false, trailingComma: 'es5' },
        },
      };

      const result = formatRepoConventionsPromptSection(ctx, 'test-repo');
      expect(result).toContain('Linter: prettier');
      expect(result).toContain('semi');
    });

    it('omits Framework line when NestJS is not detected', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        keyDependencies: ['express'],
      };

      const result = formatRepoConventionsPromptSection(ctx, 'test-repo');
      expect(result).not.toContain('Framework: NestJS');
    });

    it('omits linter section when linter is null', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        nestjsDetected: true,
      };

      const result = formatRepoConventionsPromptSection(ctx, 'test-repo');
      expect(result).not.toContain('Linter:');
      expect(result).toContain('Framework: NestJS');
    });

    it('uses non-strict label when strict is false', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        typescript: {
          strict: false,
          module: 'esm',
          target: 'ES2020',
          paths: {},
        },
      };

      const result = formatRepoConventionsPromptSection(ctx, 'test-repo');
      expect(result).toContain('TypeScript: non-strict, esm, ES2020');
    });
  });
});
