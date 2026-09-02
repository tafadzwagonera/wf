import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  detectPackageManager,
  detectRepoConventions,
  formatRepoConventionsPromptSection,
  RepoConventionsContext,
} from './detect-repo-conventions';

jest.mock('fs');

const REPO_DIR = '/fake/repo';
const SRC_DIR = path.join(REPO_DIR, 'src');

const mockExistsSync = fs.existsSync as jest.MockedFunction<typeof fs.existsSync>;
const mockReadFileSync = fs.readFileSync as jest.MockedFunction<typeof fs.readFileSync>;
const mockReaddirSync = fs.readdirSync as jest.Mock;

const createMockPackageJson = (overrides: Record<string, unknown> = {}): string =>
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

const createMockLefthookYml = (): string =>
  'pre-commit:\n  commands:\n    lint:\n      run: yarn lint\n    typecheck:\n      run: yarn typecheck\n';

const createMockEmptyContext = (): RepoConventionsContext => ({
  language: 'unknown',
  linter: null,
  formatter: null,
  typescript: null,
  go: null,
  python: null,
  terraform: null,
  folderStructure: [],
  namingPattern: 'mixed',
  nestjsDetected: false,
  importStyle: 'unknown',
  keyDependencies: [],
  errorHandlingPaths: [],
  packageManager: 'npm',
  gitHooks: [],
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
          s === path.join(REPO_DIR, '.eslintrc.json')
          || s === path.join(REPO_DIR, 'tsconfig.json')
          || s === path.join(REPO_DIR, 'package.json')
          || s === SRC_DIR
        );
      });

      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        const s = String(p);
        if (s === path.join(REPO_DIR, '.eslintrc.json')) return createMockEslintRc();
        if (s === path.join(REPO_DIR, 'tsconfig.json')) return createMockTsConfig();
        if (s === path.join(REPO_DIR, 'package.json')) return createMockPackageJson();
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
        if (s === SRC_DIR) return [mockAgentsDir, mockCommandsDir, mockErrorFile] as fs.Dirent[];
        return [] as fs.Dirent[];
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.linter).not.toBeNull();
      expect(result.linter?.tool).toBe('eslint');
      expect(result.linter?.keyRules['semi']).toBeDefined();
      expect(result.formatter).toBeNull();
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
      expect(result.formatter).toBeNull();
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

  describe('eslint and prettier detection', () => {
    it('detects eslint flat config files', () => {
      const eslintConfigPath = path.join(REPO_DIR, 'eslint.config.mjs');
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === eslintConfigPath);

      const result = detectRepoConventions(REPO_DIR);

      expect(result.linter?.tool).toBe('eslint');
    });

    it('prioritizes eslint flat config over legacy config', () => {
      const flatConfigPath = path.join(REPO_DIR, 'eslint.config.mjs');
      const legacyConfigPath = path.join(REPO_DIR, '.eslintrc.json');
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const value = String(p);
        return value === flatConfigPath || value === legacyConfigPath;
      });
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        const value = String(p);
        if (value === flatConfigPath) return 'export default []';
        if (value === legacyConfigPath) return JSON.stringify({ rules: { semi: ['error', 'always'] } });
        return '{}';
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.linter?.tool).toBe('eslint');
      expect(result.linter?.keyRules['semi']).toBeUndefined();
    });

    it('detects formatter alongside linter', () => {
      const eslintConfigPath = path.join(REPO_DIR, '.eslintrc.json');
      const prettierConfigPath = path.join(REPO_DIR, '.prettierrc.json');
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const value = String(p);
        return value === eslintConfigPath || value === prettierConfigPath;
      });
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        const value = String(p);
        if (value === eslintConfigPath) return createMockEslintRc();
        if (value === prettierConfigPath) return JSON.stringify({ semi: false, singleQuote: true });
        return '{}';
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.linter).toEqual({
        tool: 'eslint',
        keyRules: {
          semi: ['error', 'always'],
          quotes: ['error', 'single'],
          trailingComma: ['error', 'always-multiline'],
        },
      });
      expect(result.formatter).toEqual({
        tool: 'prettier',
        keyRules: {
          semi: false,
          singleQuote: true,
        },
      });
    });

    it('detects prettier config from package.json', () => {
      const packageJsonPath = path.join(REPO_DIR, 'package.json');
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === packageJsonPath);
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === packageJsonPath) {
          return createMockPackageJson({
            prettier: { semi: false, singleQuote: true },
          });
        }
        return '{}';
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.formatter).toEqual({
        tool: 'prettier',
        keyRules: {
          semi: false,
          singleQuote: true,
        },
      });
    });

    it('detects eslint config from package.json', () => {
      const packageJsonPath = path.join(REPO_DIR, 'package.json');
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === packageJsonPath);
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === packageJsonPath) {
          return createMockPackageJson({
            eslintConfig: {
              rules: {
                semi: ['error', 'always'],
                'max-depth': ['error', 4],
              },
            },
          });
        }
        return '{}';
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.linter?.tool).toBe('eslint');
      expect(result.linter?.keyRules['max-depth']).toEqual(['error', 4]);
    });

    it('extracts structural eslint rules', () => {
      const eslintConfigPath = path.join(REPO_DIR, '.eslintrc.json');
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === eslintConfigPath);
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === eslintConfigPath) {
          return createMockEslintRc({
            'max-depth': ['error', 4],
            complexity: ['error', 8],
          });
        }
        return '{}';
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.linter?.keyRules['max-depth']).toEqual(['error', 4]);
      expect(result.linter?.keyRules['complexity']).toEqual(['error', 8]);
    });

    it('parses prettier yaml configs', () => {
      const prettierConfigPath = path.join(REPO_DIR, '.prettierrc.yml');
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === prettierConfigPath);
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === prettierConfigPath) return 'semi: false\nsingleQuote: true\n';
        return '{}';
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.formatter).toEqual({
        tool: 'prettier',
        keyRules: {
          semi: false,
          singleQuote: true,
        },
      });
    });
  });

  describe('naming pattern classification', () => {
    const makeFileEntry = (name: string): fs.Dirent => ({ name, isDirectory: () => false }) as fs.Dirent;

    beforeEach(() => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === SRC_DIR);
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
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'package.json'));
      mockReadFileSync.mockReturnValue(
        createMockPackageJson({
          dependencies: { '@nestjs/core': '^10.0.0' },
          devDependencies: {},
        })
      );

      const result = detectRepoConventions(REPO_DIR);
      expect(result.nestjsDetected).toBe(true);
    });

    it('sets nestjsDetected to false when @nestjs/core is absent', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'package.json'));
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          dependencies: { express: '^4.0.0' },
          devDependencies: {},
        })
      );

      const result = detectRepoConventions(REPO_DIR);
      expect(result.nestjsDetected).toBe(false);
    });
  });

  describe('import style detection', () => {
    it('returns commonjs when tsconfig module is commonjs', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'tsconfig.json'));
      mockReadFileSync.mockReturnValue(createMockTsConfig({ module: 'commonjs' }));

      const result = detectRepoConventions(REPO_DIR);
      expect(result.importStyle).toBe('commonjs');
    });

    it('returns esm when tsconfig module is ESNext', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'tsconfig.json'));
      mockReadFileSync.mockReturnValue(createMockTsConfig({ module: 'ESNext' }));

      const result = detectRepoConventions(REPO_DIR);
      expect(result.importStyle).toBe('esm');
    });

    it('returns esm when package.json type is module', () => {
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'package.json'));
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          type: 'module',
          dependencies: {},
          devDependencies: {},
        })
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
        if (s === path.join(SRC_DIR, 'shared')) return [mockErrorFile, mockExceptionFilter] as fs.Dirent[];
        return [] as fs.Dirent[];
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.errorHandlingPaths).toHaveLength(2);
      expect(result.errorHandlingPaths.some(p => p.includes('errors.ts'))).toBe(true);
      expect(result.errorHandlingPaths.some(p => p.includes('exception.filter.ts'))).toBe(true);
    });
  });

  describe('git hooks detection', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('detects lefthook when lefthook.yml is present', () => {
      const lefthookPath = path.join(REPO_DIR, 'lefthook.yml');
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === lefthookPath);
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === lefthookPath) return createMockLefthookYml();
        return '{}';
      });
      mockReaddirSync.mockReturnValue([]);

      const result = detectRepoConventions(REPO_DIR);

      expect(result.gitHooks).toHaveLength(1);
      expect(result.gitHooks[0].tool).toBe('lefthook');
      expect(result.gitHooks[0].hooks['pre-commit']).toContain('yarn lint');
    });

    it('detects husky when .husky/ directory is present', () => {
      const huskyDir = path.join(REPO_DIR, '.husky');
      mockExistsSync.mockImplementation((p: fs.PathLike) => {
        const s = String(p);
        return s === huskyDir;
      });
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === path.join(huskyDir, 'pre-commit')) return 'yarn test\n';
        return '{}';
      });
      mockReaddirSync.mockImplementation((dir: fs.PathLike) => {
        if (String(dir) === huskyDir) return ['pre-commit'];
        return [];
      });

      const result = detectRepoConventions(REPO_DIR);

      expect(result.gitHooks).toHaveLength(1);
      expect(result.gitHooks[0].tool).toBe('husky');
      expect(result.gitHooks[0].hooks['pre-commit']).toContain('yarn test');
    });

    it('detects simple-git-hooks from package.json', () => {
      const pkgPath = path.join(REPO_DIR, 'package.json');
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === pkgPath);
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === pkgPath) {
          return JSON.stringify({ 'simple-git-hooks': { 'pre-commit': 'yarn lint' } });
        }
        return '{}';
      });
      mockReaddirSync.mockReturnValue([]);

      const result = detectRepoConventions(REPO_DIR);

      expect(result.gitHooks).toHaveLength(1);
      expect(result.gitHooks[0].tool).toBe('simple-git-hooks');
      expect(result.gitHooks[0].hooks['pre-commit'][0]).toBe('yarn lint');
    });

    it('returns empty gitHooks when no hook config is present', () => {
      mockExistsSync.mockReturnValue(false);
      mockReaddirSync.mockReturnValue([]);

      const result = detectRepoConventions(REPO_DIR);

      expect(result.gitHooks).toEqual([]);
    });

    it('swallows errors and returns empty gitHooks when lefthook.yml is malformed', () => {
      const lefthookPath = path.join(REPO_DIR, 'lefthook.yml');
      mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === lefthookPath);
      mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
        if (String(p) === lefthookPath) return ': invalid: yaml: [{{';
        return '{}';
      });
      mockReaddirSync.mockReturnValue([]);

      const result = detectRepoConventions(REPO_DIR);

      expect(result.gitHooks).toEqual([]);
    });
  });
});

describe('language detection', () => {
  it('detects typescript when tsconfig.json exists', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'tsconfig.json'));
    const result = detectRepoConventions(REPO_DIR);
    expect(result.language).toBe('typescript');
  });

  it('detects go when go.mod exists', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'go.mod'));
    mockReadFileSync.mockReturnValue('module github.com/example/myapp\n\ngo 1.21\n');
    const result = detectRepoConventions(REPO_DIR);
    expect(result.language).toBe('go');
    expect(result.go).toEqual({ modulePath: 'github.com/example/myapp' });
  });

  it('detects python when pyproject.toml exists', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'pyproject.toml'));
    mockReadFileSync.mockReturnValue('[tool.ruff]\nline-length = 88\n[tool.mypy]\n');
    const result = detectRepoConventions(REPO_DIR);
    expect(result.language).toBe('python');
    expect(result.python?.tool).toBe('pyproject');
    expect(result.python?.keySettings).toEqual({ ruff: true, mypy: true });
  });

  it('detects terraform when .tf files exist at root', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return (!(s === path.join(REPO_DIR, 'tsconfig.json')) && s !== path.join(REPO_DIR, 'package.json') && s !== path.join(REPO_DIR, 'go.mod') && s !== path.join(REPO_DIR, 'pyproject.toml') && s !== path.join(REPO_DIR, 'setup.py') && s !== path.join(REPO_DIR, 'requirements.txt') && s !== path.join(REPO_DIR, 'modules'));
    });
    // readdirSync at root returns .tf files
    mockReaddirSync.mockImplementation((dir: fs.PathLike) => {
      const s = String(dir);
      if (s === REPO_DIR) return ['main.tf', 'variables.tf', 'outputs.tf'];
      return [];
    });
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      if (s === path.join(REPO_DIR, 'main.tf')) return 'provider "aws" {}\nterraform {\n  backend "s3" {}\n}\n';
      if (s === path.join(REPO_DIR, 'variables.tf')) return 'variable "name" {}';
      return '';
    });

    // Need to set up existsSync carefully
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      // Not a TS/JS/Go/Python repo
      if (s.endsWith('tsconfig.json')) return false;
      if (s.endsWith('package.json')) return false;
      if (s.endsWith('go.mod')) return false;
      if (s.endsWith('pyproject.toml')) return false;
      if (s.endsWith('setup.py')) return false;
      if (s.endsWith('requirements.txt')) return false;
      if (s.endsWith('modules')) return false;
      return false;
    });

    const result = detectRepoConventions(REPO_DIR);
    expect(result.language).toBe('terraform');
    expect(result.terraform?.providers).toContain('aws');
    expect(result.terraform?.backend).toBe('s3');
  });

  it('returns unknown when no known project files exist', () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    const result = detectRepoConventions(REPO_DIR);
    expect(result.language).toBe('unknown');
  });
});

describe('Go folder structure detection', () => {
  it('scans cmd, pkg, internal directories for Go repos', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return (
        s === path.join(REPO_DIR, 'go.mod')
        || s === path.join(REPO_DIR, 'cmd')
        || s === path.join(REPO_DIR, 'pkg')
        || s === path.join(REPO_DIR, 'internal')
      );
    });
    mockReadFileSync.mockReturnValue('module github.com/example/app\n\ngo 1.21\n');

    const makeDir = (name: string): fs.Dirent => ({ name, isDirectory: () => true }) as fs.Dirent;

    mockReaddirSync.mockImplementation((dir: fs.PathLike) => {
      const s = String(dir);
      if (s === path.join(REPO_DIR, 'cmd')) return [makeDir('server'), makeDir('cli')] as fs.Dirent[];
      if (s === path.join(REPO_DIR, 'pkg')) return [makeDir('utils')] as fs.Dirent[];
      if (s === path.join(REPO_DIR, 'internal')) return [makeDir('handler')] as fs.Dirent[];
      return [] as fs.Dirent[];
    });

    const result = detectRepoConventions(REPO_DIR);
    expect(result.language).toBe('go');
    expect(result.folderStructure).toContain('cmd/server');
    expect(result.folderStructure).toContain('cmd/cli');
    expect(result.folderStructure).toContain('pkg/utils');
    expect(result.folderStructure).toContain('internal/handler');
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
        language: 'typescript',
        linter: { tool: 'eslint', keyRules: { semi: true, singleQuote: true } },
        formatter: null,
        typescript: {
          strict: true,
          module: 'commonjs',
          target: 'ES2021',
          paths: {},
        },
        go: null,
        python: null,
        terraform: null,
        folderStructure: ['agents', 'commands', 'integrations', 'shared'],
        namingPattern: 'kebab-case',
        nestjsDetected: true,
        importStyle: 'commonjs',
        keyDependencies: ['@nestjs/core', 'jest'],
        errorHandlingPaths: ['src/shared/utils/errors.ts'],
        packageManager: 'npm',
        gitHooks: [{ tool: 'lefthook' as const, hooks: { 'pre-commit': ['yarn lint'] } }],
      };

      const result = formatRepoConventionsPromptSection(ctx, 'repoName');

      expect(result).toContain('Repository conventions (repoName):');
      expect(result).toContain('Language: typescript');
      expect(result).toContain('Linter: eslint');
      expect(result).toContain('semi');
      expect(result).toContain('TypeScript: strict mode, commonjs, ES2021');
      expect(result).toContain('Folder structure: agents, commands, integrations, shared');
      expect(result).toContain('Naming: kebab-case');
      expect(result).toContain('Framework: NestJS');
      expect(result).toContain('Import style: commonjs');
      expect(result).toContain('Key deps: @nestjs/core, jest');
      expect(result).toContain('Error utilities: src/shared/utils/errors.ts');
      expect(result).toContain('Git hooks (lefthook):');
    });

    it('formats Go repo conventions', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        language: 'go',
        go: { modulePath: 'github.com/example/my-service' },
        folderStructure: ['cmd/server', 'pkg/utils'],
        keyDependencies: ['gin', 'testify'],
      };

      const result = formatRepoConventionsPromptSection(ctx, 'my-service');
      expect(result).toContain('Language: go');
      expect(result).toContain('Go module: github.com/example/my-service');
      expect(result).toContain('Folder structure: cmd/server, pkg/utils');
      expect(result).toContain('Key deps: gin, testify');
      expect(result).not.toContain('Import style');
    });

    it('formats Terraform repo conventions', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        language: 'terraform',
        terraform: {
          providers: ['aws', 'random'],
          backend: 's3',
          modulePaths: ['modules/vpc', 'modules/ecs'],
        },
        keyDependencies: ['terraform-provider-aws', 'terraform-provider-random'],
      };

      const result = formatRepoConventionsPromptSection(ctx, 'terraform-aws');
      expect(result).toContain('Language: terraform');
      expect(result).toContain('Terraform providers: aws, random');
      expect(result).toContain('Terraform backend: s3');
      expect(result).toContain('Terraform modules: modules/vpc, modules/ecs');
      expect(result).not.toContain('Import style');
    });

    it('formats Python repo conventions', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        language: 'python',
        python: { tool: 'pyproject', keySettings: { ruff: true, mypy: true } },
      };

      const result = formatRepoConventionsPromptSection(ctx, 'my-py-app');
      expect(result).toContain('Language: python');
      expect(result).toContain('Python tooling: pyproject (ruff, mypy)');
    });

    it('includes formatter section with prettier tool', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        formatter: {
          tool: 'prettier',
          keyRules: { semi: false, trailingComma: 'es5' },
        },
      };

      const result = formatRepoConventionsPromptSection(ctx, 'test-repo');
      expect(result).toContain('Formatter: prettier');
      expect(result).toContain('semi');
    });

    it('renders structural linter rules under constraints', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        linter: {
          tool: 'eslint',
          keyRules: {
            semi: ['error', 'always'],
            'max-depth': ['error', 4],
          },
        },
      };

      const result = formatRepoConventionsPromptSection(ctx, 'test-repo');

      expect(result).toContain('constraints: max-depth: ["error",4]');
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
        language: 'typescript',
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

    it('formats git hooks bullet correctly', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        gitHooks: [{ tool: 'lefthook' as const, hooks: { 'pre-commit': ['yarn lint', 'yarn typecheck'] } }],
      };

      const result = formatRepoConventionsPromptSection(ctx, 'test-repo');
      expect(result).toContain('  - pre-commit: yarn lint, yarn typecheck');
    });

    it('omits git hooks section when gitHooks is empty', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        nestjsDetected: true,
        gitHooks: [],
      };

      const result = formatRepoConventionsPromptSection(ctx, 'test-repo');
      expect(result).not.toContain('Git hooks');
    });

    it('returns an empty section when gitHooks only contains empty hook maps', () => {
      const ctx: RepoConventionsContext = {
        ...createMockEmptyContext(),
        gitHooks: [{ tool: 'simple-git-hooks', hooks: {} }],
      };

      const result = formatRepoConventionsPromptSection(ctx, 'test-repo');
      expect(result).toBe('');
    });
  });
});

describe('detectPackageManager', () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it('returns bun when bun.lockb is present alongside other lockfiles', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return (
        s === path.join(REPO_DIR, 'bun.lockb')
        || s === path.join(REPO_DIR, 'pnpm-lock.yaml')
        || s === path.join(REPO_DIR, 'yarn.lock')
      );
    });

    expect(detectPackageManager(REPO_DIR)).toBe('bun');
  });

  it('returns pnpm when pnpm-lock.yaml is present', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'pnpm-lock.yaml'));

    expect(detectPackageManager(REPO_DIR)).toBe('pnpm');
  });

  it('returns yarn when yarn.lock is present', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'yarn.lock'));

    expect(detectPackageManager(REPO_DIR)).toBe('yarn');
  });

  it('returns npm as the default when no recognized lockfile is present', () => {
    // package-lock.json is not a detection signal — npm is the bare fallback.
    // existsSync returns false for all lockfiles and for package.json itself.
    mockExistsSync.mockReturnValue(false);

    expect(detectPackageManager(REPO_DIR)).toBe('npm');
  });

  it('falls back to the packageManager field in package.json when no lockfile is present', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'package.json'));
    mockReadFileSync.mockReturnValue(createMockPackageJson({ packageManager: 'pnpm@9.0.0' }));

    expect(detectPackageManager(REPO_DIR)).toBe('pnpm');
  });

  it('returns npm when no lockfile and no packageManager field are present', () => {
    mockExistsSync.mockReturnValue(false);

    expect(detectPackageManager(REPO_DIR)).toBe('npm');
  });

  it('returns npm when only package-lock.json is present', () => {
    mockExistsSync.mockImplementation(
      (p: fs.PathLike) => String(p) === path.join(REPO_DIR, 'package-lock.json'),
    );

    expect(detectPackageManager(REPO_DIR)).toBe('npm');
  });

  it('returns yarn when yarn.lock and package-lock.json coexist with no packageManager declaration', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s === path.join(REPO_DIR, 'yarn.lock') || s === path.join(REPO_DIR, 'package-lock.json');
    });
    // package.json doesn't exist → no packageManager field → yarn has priority
    mockReadFileSync.mockReturnValue(createMockPackageJson({}));

    expect(detectPackageManager(REPO_DIR)).toBe('yarn');
  });

  it('returns npm when yarn.lock and package-lock.json coexist and packageManager declares npm', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return (
        s === path.join(REPO_DIR, 'yarn.lock')
        || s === path.join(REPO_DIR, 'package-lock.json')
        || s === path.join(REPO_DIR, 'package.json')
      );
    });
    mockReadFileSync.mockReturnValue(createMockPackageJson({ packageManager: 'npm@10.0.0' }));

    expect(detectPackageManager(REPO_DIR)).toBe('npm');
  });

  it('returns yarn when yarn.lock and package-lock.json coexist and packageManager declares yarn', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return (
        s === path.join(REPO_DIR, 'yarn.lock')
        || s === path.join(REPO_DIR, 'package-lock.json')
        || s === path.join(REPO_DIR, 'package.json')
      );
    });
    mockReadFileSync.mockReturnValue(createMockPackageJson({ packageManager: 'yarn@4.0.0' }));

    expect(detectPackageManager(REPO_DIR)).toBe('yarn');
  });
});

describe('detectRepoConventions — designSystem', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('detects @nuxt/ui from package.json dependencies', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s === path.join(REPO_DIR, 'package.json');
    });
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p) === path.join(REPO_DIR, 'package.json')) {
        return JSON.stringify({ dependencies: { '@nuxt/ui': '^4.0.0' } });
      }
      return '{}';
    });
    mockReaddirSync.mockReturnValue([]);

    const ctx = detectRepoConventions(REPO_DIR);
    expect(ctx.designSystem?.componentLibrary).toBe('@nuxt/ui');
  });

  it('detects shadcn-ui when components.json is present', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s === path.join(REPO_DIR, 'package.json') || s === path.join(REPO_DIR, 'components.json');
    });
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      const s = String(p);
      if (s === path.join(REPO_DIR, 'package.json')) return JSON.stringify({ dependencies: {} });
      if (s === path.join(REPO_DIR, 'components.json')) return JSON.stringify({ style: 'default' });
      return '{}';
    });
    mockReaddirSync.mockReturnValue([]);

    const ctx = detectRepoConventions(REPO_DIR);
    expect(ctx.designSystem?.componentLibrary).toBe('shadcn-ui');
  });

  it('reports null componentLibrary when no component library detected', () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const ctx = detectRepoConventions(REPO_DIR);
    expect(ctx.designSystem?.componentLibrary).toBeNull();
    expect(ctx.designSystem?.hasUiEnvironment).toBe(false);
  });

  it('sets hasUiEnvironment to true when a framework is detected via dependencies', () => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => {
      const s = String(p);
      return s === path.join(REPO_DIR, 'package.json');
    });
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      if (String(p) === path.join(REPO_DIR, 'package.json')) {
        return JSON.stringify({ dependencies: { next: '^14.0.0' } });
      }
      return '{}';
    });
    mockReaddirSync.mockReturnValue([]);

    const ctx = detectRepoConventions(REPO_DIR);
    expect(ctx.designSystem?.hasUiEnvironment).toBe(true);
  });

  it('formatRepoConventionsPromptSection includes Design system line when set', () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
    mockReadFileSync.mockReturnValue(JSON.stringify({ dependencies: { '@nuxt/ui': '^4.0.0' }, name: 'my-repo' }));

    const base = detectRepoConventions(REPO_DIR);
    const ctx: RepoConventionsContext = {
      ...base,
      designSystem: {
        framework: 'nuxt',
        componentLibrary: '@nuxt/ui',
        configFile: 'app/app.config.ts',
        tailwindConfig: null,
        darkModeConvention: null,
        hasStorybook: false,
        interactionPatterns: [],
        classConventions: [],
        hasUiEnvironment: true,
      },
    };
    const output = formatRepoConventionsPromptSection(ctx, 'my-repo');
    expect(output).toMatch(/Design system:/);
  });
});

describe('detectRepoConventions — designSystem.interactionPatterns', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const APP_DIR = path.join(REPO_DIR, 'app');

  const mockVueFile = (name: string): fs.Dirent => ({ name, isDirectory: () => false }) as fs.Dirent;

  // No top-level src/ (the Nuxt convention) — exercises the fallback root resolution.
  const mockSingleFileAppDir = (fileName: string): void => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === APP_DIR);
    mockReaddirSync.mockImplementation((dir: fs.PathLike) =>
      String(dir) === APP_DIR ? [mockVueFile(fileName)] : ([] as fs.Dirent[]));
  };

  it('finds the stretched-link card pattern via a real file', () => {
    mockSingleFileAppDir('TourCard.vue');
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) =>
      String(p).endsWith('TourCard.vue')
        ? '<NuxtLink class="after:absolute after:inset-0" />'
        : '{}');

    const ctx = detectRepoConventions(REPO_DIR);
    const found = ctx.designSystem?.interactionPatterns.find(p => p.pattern.includes('stretched-link'));
    expect(found?.found).toBe(true);
    expect(found?.files).toEqual(['app/TourCard.vue']);
  });

  it('flags the aria-hidden + tabindex="-1" anti-pattern when present', () => {
    mockSingleFileAppDir('BlogPostRow.vue');
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) =>
      String(p).endsWith('BlogPostRow.vue')
        ? '<NuxtLink aria-hidden="true" tabindex="-1" />'
        : '{}');

    const ctx = detectRepoConventions(REPO_DIR);
    const found = ctx.designSystem?.interactionPatterns.find(p => p.pattern.includes('aria-hidden'));
    expect(found?.found).toBe(true);
    expect(found?.files).toEqual(['app/BlogPostRow.vue']);
  });

  it('finds the scroll-reset-on-query-nav pattern via a real file', () => {
    mockSingleFileAppDir('useScrollReset.tsx');
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) =>
      String(p).endsWith('useScrollReset.tsx')
        ? 'watch(() => useRoute().query, () => window.scrollTo({ top: 0 }))'
        : '{}');

    const ctx = detectRepoConventions(REPO_DIR);
    const found = ctx.designSystem?.interactionPatterns.find(p => p.pattern.includes('scroll reset'));
    expect(found?.found).toBe(true);
  });

  it('finds the native-control-suppression pattern via a real file', () => {
    mockSingleFileAppDir('SearchField.tsx');
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) =>
      String(p).endsWith('SearchField.tsx')
        ? '.search-cancel { appearance-none; } ::-webkit-search-cancel-button { display: none; }'
        : '{}');

    const ctx = detectRepoConventions(REPO_DIR);
    const found = ctx.designSystem?.interactionPatterns.find(p => p.pattern.includes('native form-control'));
    expect(found?.found).toBe(true);
  });

  it('reports found: false with empty files when no source files match any signature', () => {
    mockSingleFileAppDir('Plain.vue');
    mockReadFileSync.mockReturnValue('<div>hello</div>');

    const ctx = detectRepoConventions(REPO_DIR);
    expect(ctx.designSystem?.interactionPatterns.every(p => !p.found && p.files.length === 0)).toBe(true);
  });

  it('returns an empty array when no scannable root exists at all', () => {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);

    const ctx = detectRepoConventions(REPO_DIR);
    expect(ctx.designSystem?.interactionPatterns).toEqual([]);
  });

  it('formatRepoConventionsPromptSection lists only the found patterns, with matching files', () => {
    mockSingleFileAppDir('TourCard.vue');
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) =>
      String(p).endsWith('TourCard.vue')
        ? '<NuxtLink class="after:absolute after:inset-0" />'
        : '{}');

    const ctx = detectRepoConventions(REPO_DIR);
    const output = formatRepoConventionsPromptSection(ctx, 'my-repo');
    expect(output).toMatch(/Known UI interaction patterns/);
    expect(output).toMatch(/stretched-link card.*app\/TourCard\.vue/);
    expect(output).not.toMatch(/scroll reset on same-route/);
  });
});

describe('formatRepoConventionsPromptSection — includeDesignSystem gate', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const makeCtxWithDesignSystem = (): RepoConventionsContext => ({
    language: 'typescript',
    linter: null,
    formatter: null,
    typescript: null,
    go: null,
    python: null,
    terraform: null,
    folderStructure: [],
    namingPattern: 'kebab-case',
    nestjsDetected: false,
    importStyle: 'esm',
    keyDependencies: ['nuxt-ui'],
    errorHandlingPaths: [],
    packageManager: 'npm',
    gitHooks: [],
    designSystem: {
      framework: 'vue',
      configFile: null,
      tailwindConfig: null,
      darkModeConvention: null,
      componentLibrary: 'nuxt-ui',
      hasStorybook: false,
      interactionPatterns: [{ pattern: 'stretched-link card', found: true, files: ['app/TourCard.vue'] }],
    },
  } as any);

  it('includes the Design system section when includeDesignSystem is true', () => {
    const output = formatRepoConventionsPromptSection(makeCtxWithDesignSystem(), 'repo', { includeDesignSystem: true });
    expect(output).toContain('Design system:');
    expect(output).toContain('Known UI interaction patterns');
  });

  it('omits the entire Design system section when includeDesignSystem is false', () => {
    const output = formatRepoConventionsPromptSection(makeCtxWithDesignSystem(), 'repo', { includeDesignSystem: false });
    expect(output).not.toContain('Design system:');
    expect(output).not.toContain('- Known UI interaction patterns');
    expect(output).toContain('Repository conventions');
  });

  it('includes the Design system section by default when opts is omitted', () => {
    const output = formatRepoConventionsPromptSection(makeCtxWithDesignSystem(), 'repo');
    expect(output).toContain('Design system:');
  });
});

describe('detectRepoConventions — designSystem.classConventions', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const APP_DIR_E = path.join(REPO_DIR, 'app');

  const mockVueFileE = (name: string): fs.Dirent => ({ name, isDirectory: () => false }) as fs.Dirent;

  const mockAppDirFiles = (files: Array<{ name: string; content: string }>): void => {
    mockExistsSync.mockImplementation((p: fs.PathLike) => String(p) === APP_DIR_E);
    mockReaddirSync.mockImplementation((dir: fs.PathLike) =>
      String(dir) === APP_DIR_E ? files.map(f => mockVueFileE(f.name)) : ([] as fs.Dirent[]));
    mockReadFileSync.mockImplementation((p: fs.PathOrFileDescriptor) => {
      const file = files.find(f => String(p).endsWith(f.name));
      return file ? file.content : '{}';
    });
  };

  it('detects high-confidence h2 convention when 3+ files agree', () => {
    mockAppDirFiles([
      { name: 'A.vue', content: '<h2 class="font-bold text-2xl">Title</h2>' },
      { name: 'B.vue', content: '<h2 class="font-bold text-2xl">Title</h2>' },
      { name: 'C.vue', content: '<h2 class="font-bold text-2xl">Title</h2>' },
    ]);

    const ctx = detectRepoConventions(REPO_DIR);
    const conv = ctx.designSystem?.classConventions.find(c => c.element === 'h2');
    expect(conv).toBeDefined();
    expect(conv?.modalClasses).toBe('font-bold text-2xl');
    expect(conv?.confidence).toBe('high');
    expect(conv?.occurrences).toBe(3);
    expect(conv?.totalSamples).toBe(3);
    expect(conv?.files.length).toBeGreaterThan(0);
  });

  it('canonicalises class attribute order before comparing (sorted alphabetically)', () => {
    mockAppDirFiles([
      { name: 'A.vue', content: '<h3 class="text-xl font-semibold">T</h3>' },
      { name: 'B.vue', content: '<h3 class="font-semibold text-xl">T</h3>' },
      { name: 'C.vue', content: '<h3 class="font-semibold text-xl">T</h3>' },
    ]);

    const ctx = detectRepoConventions(REPO_DIR);
    const conv = ctx.designSystem?.classConventions.find(c => c.element === 'h3');
    expect(conv?.confidence).toBe('high');
    expect(conv?.modalClasses).toBe('font-semibold text-xl');
  });

  it('marks confidence low when top two variants are within 20% of each other', () => {
    mockAppDirFiles([
      { name: 'A.vue', content: '<h1 class="font-bold text-4xl">T</h1>' },
      { name: 'B.vue', content: '<h1 class="font-bold text-4xl">T</h1>' },
      { name: 'C.vue', content: '<h1 class="font-bold text-4xl">T</h1>' },
      { name: 'D.vue', content: '<h1 class="font-semibold text-3xl">T</h1>' },
      { name: 'E.vue', content: '<h1 class="font-semibold text-3xl">T</h1>' },
      { name: 'F.vue', content: '<h1 class="font-semibold text-3xl">T</h1>' },
    ]);

    const ctx = detectRepoConventions(REPO_DIR);
    const conv = ctx.designSystem?.classConventions.find(c => c.element === 'h1');
    expect(conv?.confidence).toBe('low');
  });

  it('does not report an element with fewer than 3 samples', () => {
    mockAppDirFiles([
      { name: 'A.vue', content: '<h4 class="font-bold">T</h4>' },
      { name: 'B.vue', content: '<h4 class="font-bold">T</h4>' },
    ]);

    const ctx = detectRepoConventions(REPO_DIR);
    const conv = ctx.designSystem?.classConventions.find(c => c.element === 'h4');
    expect(conv).toBeUndefined();
  });

  it('skips dynamic :class bindings without crashing', () => {
    mockAppDirFiles([
      { name: 'A.vue', content: '<h2 :class="{ \'font-bold\': active }">T</h2>' },
      { name: 'B.vue', content: '<h2 :class="computedClass">T</h2>' },
    ]);

    expect(() => detectRepoConventions(REPO_DIR)).not.toThrow();
    const ctx = detectRepoConventions(REPO_DIR);
    const conv = ctx.designSystem?.classConventions.find(c => c.element === 'h2');
    expect(conv).toBeUndefined();
  });

  it('detects grid-gap convention when class attribute contains both grid and a gap-* token', () => {
    mockAppDirFiles([
      { name: 'A.vue', content: '<div class="grid gap-4 grid-cols-3">A</div>' },
      { name: 'B.vue', content: '<div class="grid gap-4 grid-cols-3">B</div>' },
      { name: 'C.vue', content: '<div class="grid gap-4 grid-cols-3">C</div>' },
    ]);

    const ctx = detectRepoConventions(REPO_DIR);
    const conv = ctx.designSystem?.classConventions.find(c => c.element === 'grid-gap');
    expect(conv).toBeDefined();
    expect(conv?.confidence).toBe('high');
  });

  it('hasMeaningfulConventionsData returns true when classConventions has high-confidence entries', () => {
    mockAppDirFiles([
      { name: 'A.vue', content: '<h2 class="font-bold text-2xl">T</h2>' },
      { name: 'B.vue', content: '<h2 class="font-bold text-2xl">T</h2>' },
      { name: 'C.vue', content: '<h2 class="font-bold text-2xl">T</h2>' },
    ]);

    const ctx = detectRepoConventions(REPO_DIR);
    const minimalCtx = {
      ...ctx,
      linter: null, formatter: null, typescript: null, go: null, python: null, terraform: null,
      folderStructure: [], nestjsDetected: false, keyDependencies: [], errorHandlingPaths: [],
      gitHooks: [],
      designSystem: {
        ...(ctx.designSystem ?? {}),
        componentLibrary: null,
        interactionPatterns: [],
      },
    } as any;

    const output = formatRepoConventionsPromptSection(minimalCtx, 'my-repo');
    expect(output).not.toBe('');
    expect(output).toContain('Element class conventions');
  });

  it('formatRepoConventionsPromptSection renders high-confidence convention', () => {
    mockAppDirFiles([
      { name: 'A.vue', content: '<h2 class="font-bold text-2xl">T</h2>' },
      { name: 'B.vue', content: '<h2 class="font-bold text-2xl">T</h2>' },
      { name: 'C.vue', content: '<h2 class="font-bold text-2xl">T</h2>' },
    ]);

    const ctx = detectRepoConventions(REPO_DIR);
    const output = formatRepoConventionsPromptSection(ctx, 'my-repo');
    expect(output).toContain('Element class conventions');
    expect(output).toMatch(/h2.*"font-bold text-2xl".*\(3\/3/);
    expect(output).toMatch(/A\.vue/);
  });

  it('marks confidence low at the exact 0.8 boundary (second/top = 4/5)', () => {
    mockAppDirFiles([
      { name: 'A.vue', content: '<h1 class="font-bold text-4xl">T</h1>' },
      { name: 'B.vue', content: '<h1 class="font-bold text-4xl">T</h1>' },
      { name: 'C.vue', content: '<h1 class="font-bold text-4xl">T</h1>' },
      { name: 'D.vue', content: '<h1 class="font-bold text-4xl">T</h1>' },
      { name: 'E.vue', content: '<h1 class="font-bold text-4xl">T</h1>' },
      { name: 'F.vue', content: '<h1 class="font-semibold text-3xl">T</h1>' },
      { name: 'G.vue', content: '<h1 class="font-semibold text-3xl">T</h1>' },
      { name: 'H.vue', content: '<h1 class="font-semibold text-3xl">T</h1>' },
      { name: 'I.vue', content: '<h1 class="font-semibold text-3xl">T</h1>' },
    ]);

    const ctx = detectRepoConventions(REPO_DIR);
    const conv = ctx.designSystem?.classConventions.find(c => c.element === 'h1');
    expect(conv?.confidence).toBe('low');
  });
});
