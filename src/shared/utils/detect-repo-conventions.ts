import * as fs from 'node:fs';
import * as path from 'node:path';
import * as YAML from 'yaml';
import type { GitHooksContext, RepoLanguage, RepoConventionsContext } from '../types/detection.types';
import { buildSkipDirs, walkDir } from './walk-dir';

export type { RepoLanguage, RepoConventionsContext } from '../types/detection.types';

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

export const packageManagerScriptArgSeparator = (pm: PackageManager): string =>
  pm === 'npm' ? ' -- ' : ' ';

/**
 * Read the packageManager field declared in package.json, if any.
 *
 * @param pkgPath - Absolute path to package.json
 * @returns The declared package manager, or 'npm' when absent/unreadable
 */
const detectPackageManagerFromPkgJson = (pkgPath: string): PackageManager | null => {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const declared = pkg['packageManager'];
    if (typeof declared !== 'string') return null;
    if (declared.startsWith('bun')) return 'bun';
    if (declared.startsWith('pnpm')) return 'pnpm';
    if (declared.startsWith('yarn')) return 'yarn';
    if (declared.startsWith('npm')) return 'npm';
    return null;
  } catch {
    return null;
  }
};

const resolveYarnNpmLockfileConflict = (repoDir: string): PackageManager => {
  const pkgPath = path.join(repoDir, 'package.json');
  const declared = fs.existsSync(pkgPath) ? detectPackageManagerFromPkgJson(pkgPath) : null;
  return declared ?? 'yarn';
};

export const detectPackageManager = (repoDir: string): PackageManager => {
  if (fs.existsSync(path.join(repoDir, 'bun.lockb'))) return 'bun';
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) return 'pnpm';

  const hasYarnLock = fs.existsSync(path.join(repoDir, 'yarn.lock'));
  const hasNpmLock = fs.existsSync(path.join(repoDir, 'package-lock.json'));
  if (hasYarnLock && hasNpmLock) return resolveYarnNpmLockfileConflict(repoDir);
  if (hasYarnLock) return 'yarn';
  if (hasNpmLock) return 'npm';

  const pkgPath = path.join(repoDir, 'package.json');
  return (fs.existsSync(pkgPath) ? detectPackageManagerFromPkgJson(pkgPath) : null) ?? 'npm';
};

const keyDependencyKeywords = [
  '@nestjs/core',
  '@chakra-ui/react',
  '@emotion/react',
  '@mui/material',
  '@nuxt/ui',
  'class-variance-authority',
  'express',
  'fastify',
  'primevue',
  'react',
  'next',
  'angular',
  'vue',
  'vuetify',
  'jest',
  'vitest',
  'mocha',
  'styled-components',
  'tailwindcss',
];

interface LanguageDetectionResult {
  language: RepoLanguage;
  hasTsConfig: boolean;
  hasPkgJson: boolean;
  hasGoMod: boolean;
  hasPyProject: boolean;
  hasSetupPy: boolean;
  hasRequirementsTxt: boolean;
  hasTfFiles: boolean;
}

interface LanguageFlags {
  hasTsConfig: boolean;
  hasPkgJson: boolean;
  hasGoMod: boolean;
  hasPyProject: boolean;
  hasSetupPy: boolean;
  hasRequirementsTxt: boolean;
  hasTfFiles: boolean;
}

interface NamingCounts {
  camelCount: number;
  kebabCount: number;
  pascalCount: number;
}

interface PackageJsonResult {
  pkgDeps: Record<string, string>;
  pkgDevDeps: Record<string, string>;
  pkgType: string | undefined;
  pkgExtra: Record<string, unknown>;
}

/**
 * Count naming pattern occurrences in a list of file base names.
 *
 * @param names - File base names (without extension)
 * @returns Counts for each naming convention
 */
const countNamingPatterns = (names: string[]): NamingCounts => {
  let camelCount = 0;
  let kebabCount = 0;
  let pascalCount = 0;

  for (const name of names) {
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) pascalCount++;
    else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) camelCount++;
    else if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) kebabCount++;
  }

  return { camelCount, kebabCount, pascalCount };
};

/**
 * Classify a list of filenames into a naming pattern.
 *
 * @param names - File base names (without extension)
 * @returns The detected naming pattern
 */
const classifyNamingPattern = (names: string[]): 'camelCase' | 'kebab-case' | 'PascalCase' | 'mixed' => {
  if (names.length === 0) return 'mixed';

  const { camelCount, kebabCount, pascalCount } = countNamingPatterns(names);
  const total = camelCount + kebabCount + pascalCount;
  if (total === 0) return 'mixed';

  const dominant = Math.max(camelCount, kebabCount, pascalCount);
  if (dominant / names.length < 0.6) return 'mixed';

  if (dominant === camelCount) return 'camelCase';
  if (dominant === kebabCount) return 'kebab-case';
  return 'PascalCase';
};

/**
 * Check whether any .tf files exist in the given directory.
 *
 * @param repoDir - Repository root directory
 * @returns True if at least one .tf file exists
 */
const hasTerraformFiles = (repoDir: string): boolean => {
  try {
    return fs.readdirSync(repoDir).some(e => e.endsWith('.tf'));
  } catch {
    return false;
  }
};

/**
 * Detect the primary language and marker files for a repository.
 *
 * @param repoDir - Absolute path to the repository root
 * @returns Detection result with language and file-existence flags
 */
const detectLanguage = (repoDir: string): LanguageDetectionResult => {
  const hasTsConfig = fs.existsSync(path.join(repoDir, 'tsconfig.json'));
  const hasPkgJson = fs.existsSync(path.join(repoDir, 'package.json'));
  const hasGoMod = fs.existsSync(path.join(repoDir, 'go.mod'));
  const hasPyProject = fs.existsSync(path.join(repoDir, 'pyproject.toml'));
  const hasSetupPy = fs.existsSync(path.join(repoDir, 'setup.py'));
  const hasRequirementsTxt = fs.existsSync(path.join(repoDir, 'requirements.txt'));
  const hasTfFiles = hasTerraformFiles(repoDir);

  const flags: LanguageFlags = {
    hasTsConfig, hasPkgJson, hasGoMod, hasPyProject, hasSetupPy, hasRequirementsTxt, hasTfFiles,
  };

  return { language: resolveLanguage(flags), ...flags };
};

/**
 * Map file-existence flags to a primary language.
 *
 * @param flags - Language detection flags
 * @returns The resolved repo language
 */
const resolveLanguage = (flags: LanguageFlags): RepoLanguage => {
  if (flags.hasTsConfig) return 'typescript';
  if (flags.hasPkgJson) return 'javascript';
  if (flags.hasGoMod) return 'go';
  if (flags.hasPyProject || flags.hasSetupPy || flags.hasRequirementsTxt) return 'python';
  if (flags.hasTfFiles) return 'terraform';
  return 'unknown';
};

/**
 * Detect Go module context from go.mod.
 *
 * @param repoDir - Repository root directory
 * @param hasGoMod - Whether go.mod exists
 * @returns Go context or null
 */
const detectGoContext = (repoDir: string, hasGoMod: boolean): RepoConventionsContext['go'] => {
  if (!hasGoMod) return null;
  try {
    const raw = fs.readFileSync(path.join(repoDir, 'go.mod'), 'utf-8');
    const moduleMatch = /^module\s+(\S+)/m.exec(raw);
    return { modulePath: moduleMatch ? moduleMatch[1] : '' };
  } catch {
    return null;
  }
};

const pyLinterCandidates: Array<{
  file: string;
  tool: string;
  extract: (raw: string) => Record<string, unknown>;
}> = [
  {
    file: 'pyproject.toml',
    tool: 'pyproject',
    extract: raw => {
      const settings: Record<string, unknown> = {};
      if (/\[tool\.ruff]/.test(raw)) settings['ruff'] = true;
      if (/\[tool\.black]/.test(raw)) settings['black'] = true;
      if (/\[tool\.mypy]/.test(raw)) settings['mypy'] = true;
      if (/\[tool\.pytest/.test(raw)) settings['pytest'] = true;
      return settings;
    },
  },
  { file: '.flake8', tool: 'flake8', extract: () => ({}) },
  { file: 'setup.cfg', tool: 'setup.cfg', extract: () => ({}) },
];

/**
 * Detect Python tooling context from config files.
 *
 * @param repoDir - Repository root directory
 * @param language - The detected primary language
 * @returns Python context or null
 */
const detectPythonContext = (repoDir: string, language: RepoLanguage): RepoConventionsContext['python'] => {
  if (language !== 'python') return null;

  for (const candidate of pyLinterCandidates) {
    const pyPath = path.join(repoDir, candidate.file);
    if (!fs.existsSync(pyPath)) continue;
    try {
      const raw = fs.readFileSync(pyPath, 'utf-8');
      return { tool: candidate.tool, keySettings: candidate.extract(raw) };
    } catch {} // eslint-disable-line no-empty
  }

  return null;
};

/**
 * Parse a single .tf file for provider and backend declarations.
 *
 * @param filePath - Absolute path to the .tf file
 * @param providers - Mutable array to append providers to
 * @returns The backend string if found, or null
 */
const parseTfFile = (filePath: string, providers: string[]): string | null => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    for (const m of raw.matchAll(/provider\s+"([^"]+)"/g)) {
      if (!providers.includes(m[1])) providers.push(m[1]);
    }
    const backendMatch = /backend\s+"([^"]+)"/.exec(raw);
    return backendMatch ? backendMatch[1] : null;
  } catch {
    return null;
  }
};

/**
 * Scan .tf files in a directory for provider and backend declarations.
 *
 * @param repoDir - Repository root directory
 * @returns Object with providers array and backend string or null
 */
const scanTfProviders = (repoDir: string): { providers: string[]; backend: string | null } => {
  const providers: string[] = [];
  let backend: string | null = null;

  try {
    for (const entry of fs.readdirSync(repoDir).filter(e => e.endsWith('.tf'))) {
      const result = parseTfFile(path.join(repoDir, entry), providers);
      if (result) backend = result;
    }
  } catch { /* leave empty */ }

  return { providers, backend };
};

/**
 * Scan a directory for subdirectories that contain .tf files.
 *
 * @param dir - The directory to scan
 * @param prefix - Path prefix for the module paths
 * @returns Array of module path strings
 */
const scanModules = (dir: string, prefix: string): string[] => {
  const modulePaths: string[] = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const subEntries = fs.readdirSync(path.join(dir, entry.name));
        if (subEntries.some(e => e.endsWith('.tf'))) {
          modulePaths.push(prefix ? `${prefix}/${entry.name}` : entry.name);
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return modulePaths;
};

/**
 * Detect Terraform context from .tf files.
 *
 * @param repoDir - Repository root directory
 * @param hasTfFiles - Whether .tf files exist
 * @returns Terraform context or null
 */
const detectTerraformContext = (repoDir: string, hasTfFiles: boolean): RepoConventionsContext['terraform'] => {
  if (!hasTfFiles) return null;

  const { providers, backend } = scanTfProviders(repoDir);
  const modulesDir = path.join(repoDir, 'modules');
  const modulePaths = fs.existsSync(modulesDir) ? scanModules(modulesDir, 'modules') : [];

  return { providers, backend, modulePaths };
};

/**
 * Find the first existing file from a list of candidates.
 *
 * @param repoDir - Repository root directory
 * @param candidates - Array of filenames to check
 * @returns The first found filename, or null
 */
const findFirst = (repoDir: string, candidates: string[]): string | null => {
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(repoDir, candidate))) return candidate;
  }
  return null;
};

/**
 * Parse a config file into a record, returning empty on failure.
 *
 * @param filePath - Absolute path to the config file
 * @returns Parsed record or empty object
 */
const parseConfigFile = (filePath: string): Record<string, unknown> => {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
      return (YAML.parse(raw) as Record<string, unknown>) ?? {};
    }
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

/**
 * Extract key ESLint rules from a parsed config.
 *
 * @param parsed - Parsed ESLint config object
 * @returns Record of key rules
 */
const extractEslintKeyRules = (parsed: Record<string, unknown>): Record<string, unknown> => {
  const keyRules: Record<string, unknown> = {};
  const rules = (parsed['rules'] as Record<string, unknown>) ?? {};
  const semi = rules['semi'];
  const quotes = rules['quotes'];
  const trailingComma = rules['comma-dangle'] ?? rules['trailingComma'];

  if (semi !== undefined) keyRules['semi'] = semi;
  if (quotes !== undefined) keyRules['quotes'] = quotes;
  if (trailingComma !== undefined) keyRules['trailingComma'] = trailingComma;
  for (const rule of eslintStructuralRules) {
    if (rules[rule] !== undefined) keyRules[rule] = rules[rule];
  }
  return keyRules;
};

/**
 * Extract key Prettier rules from a parsed config.
 *
 * @param parsed - Parsed Prettier config object
 * @returns Record of key rules
 */
const extractPrettierKeyRules = (parsed: Record<string, unknown>): Record<string, unknown> => {
  const keyRules: Record<string, unknown> = {};
  if (parsed['semi'] !== undefined) keyRules['semi'] = parsed['semi'];
  if (parsed['singleQuote'] !== undefined) keyRules['singleQuote'] = parsed['singleQuote'];
  if (parsed['trailingComma'] !== undefined) keyRules['trailingComma'] = parsed['trailingComma'];
  return keyRules;
};

/**
 * Extract key Biome rules from a parsed config.
 *
 * @param parsed - Parsed Biome config object
 * @returns Record of key rules
 */
const extractBiomeKeyRules = (parsed: Record<string, unknown>): Record<string, unknown> => {
  const keyRules: Record<string, unknown> = {};
  const linterSection = (parsed['linter'] as Record<string, unknown>) ?? {};
  if (linterSection['rules'] !== undefined) keyRules['rules'] = linterSection['rules'];
  const formatterSection = (parsed['formatter'] as Record<string, unknown>) ?? {};
  if (formatterSection['indentStyle'] !== undefined) keyRules['indentStyle'] = formatterSection['indentStyle'];
  return keyRules;
};

/**
 * Extract linter tool name and key rules from a config file.
 *
 * @param tool - The linter tool name
 * @param filePath - Absolute path to the config file
 * @returns Object with tool name and key rules
 */
const extractLinterRules = (tool: string, filePath: string): { tool: string; keyRules: Record<string, unknown> } => {
  const parsed = parseConfigFile(filePath);
  if (tool === 'eslint') return { tool, keyRules: extractEslintKeyRules(parsed) };
  if (tool === 'prettier') return { tool, keyRules: extractPrettierKeyRules(parsed) };
  if (tool === 'biome') return { tool, keyRules: extractBiomeKeyRules(parsed) };
  return { tool, keyRules: {} };
};

const eslintStructuralRules = ['max-lines-per-function', 'max-depth', 'max-params', 'max-len', 'complexity'];
const eslintCandidates = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
];
const prettierCandidates = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.yml',
  '.prettierrc.yaml',
  '.prettierrc.toml',
  '.prettierrc.js',
  '.prettierrc.cjs',
  '.prettierrc.mjs',
  '.prettierrc.ts',
  '.prettierrc.mts',
  '.prettierrc.cts',
  'prettier.config.js',
  'prettier.config.cjs',
  'prettier.config.mjs',
  'prettier.config.ts',
  'prettier.config.mts',
  'prettier.config.cts',
];
const biomeCandidates = ['biome.json'];

/**
 * Detect the linter configuration for the repository.
 *
 * @param repoDir - Repository root directory
 * @returns Linter context or null
 */
const detectLinter = (repoDir: string): RepoConventionsContext['linter'] => {
  const eslintFile = findFirst(repoDir, eslintCandidates);
  if (eslintFile) return extractLinterRules('eslint', path.join(repoDir, eslintFile));

  const pkg = readPackageJson(repoDir);
  const eslintConfig = pkg.pkgExtra['eslintConfig'];
  if (eslintConfig && typeof eslintConfig === 'object') {
    return { tool: 'eslint', keyRules: extractEslintKeyRules(eslintConfig as Record<string, unknown>) };
  }

  const biomeFile = findFirst(repoDir, biomeCandidates);
  if (biomeFile) return extractLinterRules('biome', path.join(repoDir, biomeFile));

  return null;
};

/**
 * Detect the formatter configuration for the repository.
 *
 * @param repoDir - Repository root directory
 * @returns Formatter context or null
 */
const detectFormatter = (repoDir: string): RepoConventionsContext['formatter'] => {
  const prettierFile = findFirst(repoDir, prettierCandidates);
  if (prettierFile) return extractLinterRules('prettier', path.join(repoDir, prettierFile));

  const pkg = readPackageJson(repoDir);
  const prettierConfig = pkg.pkgExtra['prettier'];
  if (prettierConfig && typeof prettierConfig === 'object') {
    return { tool: 'prettier', keyRules: extractPrettierKeyRules(prettierConfig as Record<string, unknown>) };
  }

  return null;
};

/**
 * Extract TypeScript context from parsed tsconfig compiler options.
 *
 * @param compilerOptions - The compilerOptions object from tsconfig
 * @returns TypeScript context
 */
const extractTsCompilerContext = (compilerOptions: Record<string, unknown>): NonNullable<RepoConventionsContext['typescript']> => {
  const moduleVal = compilerOptions['module'];
  const targetVal = compilerOptions['target'];
  return {
    strict: compilerOptions['strict'] === true,
    module: typeof moduleVal === 'string' ? moduleVal : 'commonjs',
    target: typeof targetVal === 'string' ? targetVal : 'ES5',
    paths: (compilerOptions['paths'] as Record<string, string[]>) ?? {},
  };
};

/**
 * Detect TypeScript compiler configuration.
 *
 * @param repoDir - Repository root directory
 * @returns TypeScript context or null
 */
const detectTypescriptContext = (repoDir: string): RepoConventionsContext['typescript'] => {
  const tsconfigPath = path.join(repoDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(tsconfigPath, 'utf-8')) as Record<string, unknown>;
    return extractTsCompilerContext((parsed['compilerOptions'] as Record<string, unknown>) ?? {});
  } catch {
    return null;
  }
};

const pythonSkipDirs = new Set(['node_modules', '__pycache__', '.git', 'venv', '.venv']);

/**
 * Check whether a directory entry is a Python package root.
 *
 * @param repoDir - Repository root directory
 * @param entry - Directory entry to check
 * @returns True if the entry is a Python package directory
 */
const isPythonPackageDir = (repoDir: string, entry: fs.Dirent): boolean =>
  entry.isDirectory()
  && !entry.name.startsWith('.')
  && !pythonSkipDirs.has(entry.name)
  && fs.existsSync(path.join(repoDir, entry.name, '__init__.py'));

/**
 * Detect Python package source roots.
 *
 * @param repoDir - Repository root directory
 * @returns Array of source root paths
 */
const detectPythonSourceRoots = (repoDir: string): string[] => {
  const srcDir = path.join(repoDir, 'src');
  if (fs.existsSync(srcDir)) return [srcDir];

  try {
    const rootEntries = fs.readdirSync(repoDir, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (isPythonPackageDir(repoDir, entry)) return [path.join(repoDir, entry.name)];
    }
  } catch { /* leave empty */ }

  return [];
};

/**
 * Detect source root directories based on language conventions.
 *
 * @param repoDir - Repository root directory
 * @param language - The detected primary language
 * @returns Array of source root paths
 */
const detectSourceRoots = (repoDir: string, language: RepoLanguage): string[] => {
  const resolve = (dirs: string[]): string[] =>
    dirs.filter(d => fs.existsSync(path.join(repoDir, d))).map(d => path.join(repoDir, d));

  if (language === 'go') return resolve(['cmd', 'pkg', 'internal', 'api']);
  if (language === 'terraform') return resolve(['modules', 'environments', 'stacks']);
  if (language === 'python') return detectPythonSourceRoots(repoDir);

  const srcDir = path.join(repoDir, 'src');
  return fs.existsSync(srcDir) ? [srcDir] : [];
};

/**
 * Collect subdirectory names from source roots for folder structure display.
 *
 * @param sourceRoots - Array of source root directories
 * @returns Array of folder labels
 */
const collectFolderEntries = (sourceRoots: string[]): string[] => {
  const folderStructure: string[] = [];
  for (const root of sourceRoots) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const label = sourceRoots.length > 1 ? `${path.basename(root)}/${entry.name}` : entry.name;
        folderStructure.push(label);
      }
    } catch { /* leave empty */ }
  }
  return folderStructure;
};

/**
 * List top-level directories in a repository root (excluding dotfiles and node_modules).
 *
 * @param repoDir - Repository root directory
 * @returns Array of directory names
 */
const collectRootDirs = (repoDir: string): string[] => {
  try {
    return fs
      .readdirSync(repoDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map(e => e.name);
  } catch {
    return [];
  }
};

/**
 * Detect folder structure for a repository.
 *
 * @param repoDir - Repository root directory
 * @param language - The detected primary language
 * @param sourceRoots - Array of source root directories
 * @returns Array of folder labels
 */
const detectFolderStructure = (repoDir: string, language: RepoLanguage, sourceRoots: string[]): string[] => {
  const entries = collectFolderEntries(sourceRoots);
  if (sourceRoots.length === 0 && (language === 'go' || language === 'terraform')) {
    return collectRootDirs(repoDir);
  }
  return entries;
};

/**
 * Detect file naming patterns in source roots.
 *
 * @param sourceRoots - Array of source root directories
 * @param repoDir - Repository root directory
 * @returns The detected naming pattern
 */
const detectNamingPattern = (sourceRoots: string[], repoDir: string): RepoConventionsContext['namingPattern'] => {
  const namingScanDir = sourceRoots[0] ?? path.join(repoDir, 'src');
  if (!fs.existsSync(namingScanDir)) return 'mixed';

  try {
    const entries = fs.readdirSync(namingScanDir, { withFileTypes: true });
    const fileNames = entries.filter(e => !e.isDirectory()).map(e => path.basename(e.name, path.extname(e.name)));
    return classifyNamingPattern(fileNames);
  } catch {
    return 'mixed';
  }
};

/**
 * Read package.json and extract dependencies and module type.
 *
 * @param repoDir - Repository root directory
 * @returns Package dependencies and type information
 */
const readPackageJson = (repoDir: string): PackageJsonResult => {
  const pkgPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return { pkgDeps: {}, pkgDevDeps: {}, pkgType: undefined, pkgExtra: {} };

  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    return {
      pkgDeps: (parsed['dependencies'] as Record<string, string>) ?? {},
      pkgDevDeps: (parsed['devDependencies'] as Record<string, string>) ?? {},
      pkgType: parsed['type'] as string | undefined,
      pkgExtra: parsed,
    };
  } catch {
    return { pkgDeps: {}, pkgDevDeps: {}, pkgType: undefined, pkgExtra: {} };
  }
};

/**
 * Determine the import style from TypeScript config and package type.
 *
 * @param typescript - TypeScript context or null
 * @param pkgType - The package.json "type" field value
 * @returns The detected import style
 */
const detectImportStyle = (
  typescript: RepoConventionsContext['typescript'],
  pkgType: string | undefined,
): RepoConventionsContext['importStyle'] => {
  if (typescript) {
    const mod = typescript.module.toLowerCase();
    if (mod.includes('commonjs')) return 'commonjs';
    if (mod.includes('esm') || mod.includes('esnext') || mod.includes('es2015') || mod === 'nodenext' || mod === 'node16') return 'esm';
  }

  if (pkgType === 'module') return 'esm';
  if (pkgType === 'commonjs') return 'commonjs';
  return 'unknown';
};

const goKeyDeps = [
  'github.com/gin-gonic/gin',
  'github.com/gorilla/mux',
  'github.com/labstack/echo',
  'github.com/gofiber/fiber',
  'google.golang.org/grpc',
  'github.com/stretchr/testify',
  'github.com/hashicorp/terraform-plugin-sdk',
  'github.com/aws/aws-sdk-go',
];

/**
 * Detect Go dependencies from go.mod.
 *
 * @param repoDir - Repository root directory
 * @returns Array of matched Go dependency base names
 */
const detectGoDependencies = (repoDir: string): string[] => {
  try {
    const raw = fs.readFileSync(path.join(repoDir, 'go.mod'), 'utf-8');
    return goKeyDeps.filter(dep => raw.includes(dep)).map(dep => path.basename(dep));
  } catch {
    return [];
  }
};

/**
 * Detect key dependencies from all dependency sources.
 *
 * @param allDeps - Merged dependencies and devDependencies
 * @param hasGoMod - Whether go.mod exists
 * @param repoDir - Repository root directory
 * @param terraformCtx - Terraform context or null
 * @returns Array of key dependency names
 */
const detectKeyDependencies = (
  allDeps: Record<string, string>,
  hasGoMod: boolean,
  repoDir: string,
  terraformCtx: RepoConventionsContext['terraform'],
): string[] => {
  const keyDependencies = keyDependencyKeywords.filter(kw => kw in allDeps);
  if (hasGoMod) keyDependencies.push(...detectGoDependencies(repoDir));
  if (terraformCtx) {
    for (const provider of terraformCtx.providers) keyDependencies.push(`terraform-provider-${provider}`);
  }
  return keyDependencies;
};

/**
 * Resolve the directories to scan for error/exception files.
 *
 * @param sourceRoots - Array of source root directories
 * @param repoDir - Repository root directory
 * @returns Array of directories to scan
 */
const resolveErrorScanRoots = (sourceRoots: string[], repoDir: string): string[] => {
  if (sourceRoots.length > 0) return sourceRoots;
  const srcDir = path.join(repoDir, 'src');
  return fs.existsSync(srcDir) ? [srcDir] : [];
};

/**
 * Detect error handling file paths in source roots.
 *
 * @param sourceRoots - Array of source root directories
 * @param repoDir - Repository root directory
 * @param skipDirs - Set of directory names to skip during walking
 * @returns Array of file paths containing error/exception patterns
 */
const detectErrorHandlingPaths = (sourceRoots: string[], repoDir: string, skipDirs: Set<string>): string[] => {
  const errorScanRoots = resolveErrorScanRoots(sourceRoots, repoDir);
  const errorHandlingPaths: string[] = [];

  for (const root of errorScanRoots) {
    const matches = walkDir(root, filePath => {
      const base = path.basename(filePath).toLowerCase();
      return base.includes('error') || base.includes('exception');
    }, skipDirs);
    errorHandlingPaths.push(...matches);
  }

  return errorHandlingPaths;
};

interface ConventionsInputs {
  repoDir: string;
  language: RepoLanguage;
  hasGoMod: boolean;
  hasTfFiles: boolean;
  sourceRoots: string[];
  allDeps: Record<string, string>;
  pkgType: string | undefined;
  skipDirs: Set<string>;
}

/**
 * Detect language-specific contexts (linter, typescript, go, python, terraform).
 *
 * @param inputs - Pre-computed detection inputs
 * @returns Partial context with language-specific fields
 */
const detectLanguageContexts = (inputs: ConventionsInputs): Pick<
  RepoConventionsContext, 'linter' | 'formatter' | 'typescript' | 'go' | 'python' | 'terraform'
> => ({
  linter: detectLinter(inputs.repoDir),
  formatter: detectFormatter(inputs.repoDir),
  typescript: detectTypescriptContext(inputs.repoDir),
  go: detectGoContext(inputs.repoDir, inputs.hasGoMod),
  python: detectPythonContext(inputs.repoDir, inputs.language),
  terraform: detectTerraformContext(inputs.repoDir, inputs.hasTfFiles),
});

/**
 * Parse a lefthook YAML config into a hooks record.
 *
 * @param lefthookPath - Path to lefthook.yml or .lefthook.yml
 * @returns Parsed hooks record, or null on failure
 */
const lefthookHookNames = new Set(['pre-commit', 'pre-push', 'commit-msg']);

/**
 * Extract run commands from a lefthook hook config entry.
 *
 * @param hookConfig - The hook configuration object
 * @returns Array of run command strings
 */
const extractLefthookCommands = (hookConfig: unknown): string[] => {
  const cmds = (hookConfig as Record<string, unknown> | null)?.['commands'];
  if (!cmds || typeof cmds !== 'object') return [];
  return Object.values(cmds as Record<string, Record<string, unknown>>)
    .map(c => (typeof c['run'] === 'string' ? c['run'] : ''))
    .filter(Boolean);
};

const parseLefthookConfig = (lefthookPath: string): Record<string, string[]> | null => {
  try {
    const raw = fs.readFileSync(lefthookPath, 'utf-8');
    const parsed = YAML.parse(raw) as Record<string, unknown>;
    const hooks: Record<string, string[]> = {};
    for (const [hookName, hookConfig] of Object.entries(parsed)) {
      if (!lefthookHookNames.has(hookName)) continue;
      const cmds = extractLefthookCommands(hookConfig);
      if (cmds.length > 0) hooks[hookName] = cmds;
    }
    return Object.keys(hooks).length > 0 ? hooks : null;
  } catch {
    return null;
  }
};

/**
 * Detect husky hooks from the .husky/ directory.
 *
 * @param huskyDir - Path to the .husky directory
 * @returns Parsed hooks record, or null on failure
 */
const parseHuskyHooks = (huskyDir: string): Record<string, string[]> | null => {
  try {
    const entries = fs.readdirSync(huskyDir).filter(f => !f.startsWith('_') && !f.startsWith('.'));
    const hooks: Record<string, string[]> = {};
    for (const entry of entries) {
      try {
        const content = fs.readFileSync(path.join(huskyDir, entry), 'utf-8');
        hooks[entry] = content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('.'));
      } catch { /* skip unreadable file */ }
    }
    return Object.keys(hooks).length > 0 ? hooks : null;
  } catch {
    return null;
  }
};

/**
 * Detect git hooks configuration (lefthook, husky, or simple-git-hooks).
 *
 * @param repoDir - Repository root directory
 * @returns Array of detected git hook configurations
 */
const findLefthookPath = (repoDir: string): string | undefined =>
  [path.join(repoDir, 'lefthook.yml'), path.join(repoDir, '.lefthook.yml')].find(p => fs.existsSync(p));

const detectGitHooks = (repoDir: string): GitHooksContext[] => {
  const lefthookPath = findLefthookPath(repoDir);
  if (lefthookPath) {
    const hooks = parseLefthookConfig(lefthookPath);
    return hooks ? [{ tool: 'lefthook', hooks }] : [];
  }

  const huskyDir = path.join(repoDir, '.husky');
  if (fs.existsSync(huskyDir)) {
    const hooks = parseHuskyHooks(huskyDir);
    return hooks ? [{ tool: 'husky', hooks }] : [];
  }

  return detectSimpleGitHooks(repoDir, []);
};

/**
 * Detect simple-git-hooks from package.json.
 *
 * @param repoDir - Repository root directory
 * @param gitHooks - Mutable array to push results into
 * @returns The gitHooks array
 */
const detectSimpleGitHooks = (repoDir: string, gitHooks: GitHooksContext[]): GitHooksContext[] => {
  const pkgPath = path.join(repoDir, 'package.json');
  if (!fs.existsSync(pkgPath)) return gitHooks;
  try {
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as Record<string, unknown>;
    const sghConfig = parsed['simple-git-hooks'] as Record<string, string> | undefined;
    if (!sghConfig || typeof sghConfig !== 'object') return gitHooks;
    const hooks: Record<string, string[]> = {};
    for (const [hook, cmd] of Object.entries(sghConfig)) hooks[hook] = [cmd];
    gitHooks.push({ tool: 'simple-git-hooks', hooks });
  } catch { /* skip */ }
  return gitHooks;
};

/**
 * Assemble the full RepoConventionsContext from pre-computed inputs.
 *
 * @param inputs - Pre-computed detection inputs
 * @param langContexts
 * @returns A fully assembled conventions context
 */
const assembleStructuralConventions = (
  inputs: ConventionsInputs,
  langContexts: ReturnType<typeof detectLanguageContexts>
): Pick<RepoConventionsContext, 'folderStructure' | 'namingPattern' | 'nestjsDetected' | 'importStyle'> => {
  const { repoDir, language, sourceRoots, allDeps, pkgType } = inputs;
  return {
    folderStructure: detectFolderStructure(repoDir, language, sourceRoots),
    namingPattern: detectNamingPattern(sourceRoots, repoDir),
    nestjsDetected: '@nestjs/core' in allDeps,
    importStyle: detectImportStyle(langContexts.typescript, pkgType),
  };
};

type DesignSystemContext = NonNullable<RepoConventionsContext['designSystem']>;

const componentLibraryDeps: ReadonlyArray<string> = [
  '@nuxt/ui', '@mui/material', '@chakra-ui/react', 'vuetify', 'primevue', 'styled-components',
];

const resolveDesignSystemFramework = (keyDeps: string[]): DesignSystemContext['framework'] => {
  if (keyDeps.includes('@nuxt/ui') || keyDeps.includes('nuxt')) return 'nuxt';
  if (keyDeps.includes('next')) return 'next';
  if (keyDeps.includes('react')) return 'react';
  if (keyDeps.includes('vue') || keyDeps.includes('vuetify') || keyDeps.includes('primevue')) return 'vue';
  return null;
};

const resolveDesignSystemConfigFile = (repoDir: string, framework: DesignSystemContext['framework']): string | null =>
  framework === 'nuxt'
    ? findFirst(repoDir, ['app/app.config.ts', 'app.config.ts'])
    : findFirst(repoDir, ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs']);

const globalCssCandidates = [
  'src/index.css', 'src/app.css', 'app/globals.css', 'app/assets/main.css', 'styles/globals.css',
];

const detectTailwindConfig = (repoDir: string): DesignSystemContext['tailwindConfig'] => {
  const configFile = findFirst(repoDir, ['tailwind.config.ts', 'tailwind.config.js', 'tailwind.config.mjs']);
  if (configFile) return { path: configFile, mode: 'legacy-file' };
  const cssFile = findFirst(repoDir, globalCssCandidates);
  if (!cssFile) return null;
  try {
    const content = fs.readFileSync(path.join(repoDir, cssFile), 'utf-8');
    if (content.includes('@theme')) return { path: cssFile, mode: 'inline-theme' };
    if (content.includes('@config')) return { path: cssFile, mode: 'css-variables' };
  } catch { /* ignore */ }
  return null;
};

const detectDarkModeInCss = (repoDir: string): DesignSystemContext['darkModeConvention'] => {
  const cssFile = findFirst(repoDir, globalCssCandidates);
  if (!cssFile) return null;
  try {
    return fs.readFileSync(path.join(repoDir, cssFile), 'utf-8').includes('[data-theme')
      ? 'data-theme-attr'
      : null;
  } catch { return null; }
};

const detectDarkModeConvention = (
  repoDir: string, tailwindConfig: DesignSystemContext['tailwindConfig']
): DesignSystemContext['darkModeConvention'] => {
  if (tailwindConfig?.mode === 'legacy-file' && tailwindConfig.path) {
    try {
      const content = fs.readFileSync(path.join(repoDir, tailwindConfig.path), 'utf-8');
      if (/darkMode[^'"]*['"]class/.test(content)) return 'tailwind-dark';
    } catch { /* ignore */ }
  }
  return detectDarkModeInCss(repoDir);
};

type UiPatternExemplar = DesignSystemContext['interactionPatterns'][number];

const uiPatternsExtensions = new Set(['.vue', '.tsx', '.jsx']);
const uiPatternRootCandidates = ['app', 'src', 'components', 'pages'];
const UI_PATTERN_MAX_FILES_PER_PATTERN = 3;

interface UiPatternSignature {
  readonly pattern: string;
  readonly test: (content: string) => boolean;
}

const uiPatternSignatures: readonly UiPatternSignature[] = [
  {
    pattern: 'stretched-link card (one real link, stretched over the card, instead of duplicate links to the same target)',
    test: content => /after:absolute/.test(content) && /after:inset-0/.test(content),
  },
  {
    pattern: 'aria-hidden combined with tabindex="-1" (verify the element genuinely cannot receive focus — clicking a tabindex="-1" element still focuses it, so aria-hidden here is often a real accessibility bug)',
    test: content => /aria-hidden=["']true["']/.test(content) && /tabindex=["']-1["']/.test(content),
  },
  {
    pattern: 'scroll reset on same-route query-only navigation (window.scrollTo gated on a route-query change)',
    test: content => /window\.scrollTo/.test(content) && /route\.query|useRoute\(\)/.test(content),
  },
  {
    pattern: 'native form-control affordance suppressed in favour of a custom one (appearance-none on a ::-webkit-*/::-moz-* pseudo-element)',
    test: content => /appearance-none/.test(content) && /::-webkit-|::-moz-/.test(content),
  },
];

const resolveUiPatternScanRoots = (repoDir: string, sourceRoots: string[]): string[] => {
  if (sourceRoots.length > 0) return sourceRoots;
  return uiPatternRootCandidates.map(dir => path.join(repoDir, dir)).filter(dir => fs.existsSync(dir));
};

const matchSignatureFiles = (
  signature: UiPatternSignature, candidateFiles: string[], repoDir: string
): UiPatternExemplar => {
  const files: string[] = [];
  for (const filePath of candidateFiles) {
    if (files.length >= UI_PATTERN_MAX_FILES_PER_PATTERN) break;
    try {
      if (signature.test(fs.readFileSync(filePath, 'utf-8'))) files.push(path.relative(repoDir, filePath));
    } catch {} // eslint-disable-line no-empty
  }
  return { pattern: signature.pattern, found: files.length > 0, files };
};

type ElementClassConvention = DesignSystemContext['classConventions'][number];

const elementClassExtensions = new Set(['.vue', '.tsx', '.jsx', '.html']);

const canonicalizeClasses = (classStr: string): string =>
  classStr.trim().split(/\s+/).filter(Boolean).sort((a, b) => a.localeCompare(b)).join(' ');

const extractHeadingClassSamples = (
  content: string,
  relPath: string,
): Array<{ element: string; classes: string; file: string }> => {
  const results: Array<{ element: string; classes: string; file: string }> = [];
  const re = /<(h[1-6])\s[^>]*?(?<!:)\bclass="([^"]*)"[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const raw = m[2];
    if (raw.includes('{') || raw.includes('$')) continue;
    results.push({ element: m[1].toLowerCase(), classes: canonicalizeClasses(raw), file: relPath });
  }
  return results;
};

const extractGridGapSamples = (
  content: string,
  relPath: string,
): Array<{ element: string; classes: string; file: string }> => {
  const results: Array<{ element: string; classes: string; file: string }> = [];
  const re = /(?<!:)\bclass="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const tokens = m[1].split(/\s+/);
    if (tokens.includes('grid') && tokens.some(t => t.startsWith('gap-')))
      results.push({ element: 'grid-gap', classes: canonicalizeClasses(tokens.filter(t => t.startsWith('gap-')).join(' ')), file: relPath });
  }
  return results;
};

const breakpointOrder: Readonly<Record<string, number>> = { '': 0, sm: 1, md: 2, lg: 3, xl: 4, '2xl': 5 };

const breakpointRank = (token: string): number => {
  const colon = token.indexOf(':');
  return breakpointOrder[colon === -1 ? '' : token.slice(0, colon)] ?? 99;
};

const sortByBreakpoint = (tokens: string[]): string =>
  [...tokens].sort((a, b) => breakpointRank(a) - breakpointRank(b)).join(' ');

const GRID_COLS_TOKEN_RE = /^(?:[a-z0-9]{2,3}:)?grid-cols-/;

const extractGridColsSamples = (
  content: string,
  relPath: string,
): Array<{ element: string; classes: string; file: string }> => {
  const results: Array<{ element: string; classes: string; file: string }> = [];
  const re = /(?<!:)\bclass="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const tokens = m[1].split(/\s+/).filter(t => GRID_COLS_TOKEN_RE.test(t));
    if (tokens.length < 3) continue;
    results.push({ element: 'grid-cols', classes: canonicalizeClasses(tokens.join(' ')), file: relPath });
  }
  return results;
};

const rankClassSamples = (samples: Array<{ classes: string; file: string }>) => {
  const counts = new Map<string, { count: number; files: Set<string> }>();
  for (const s of samples) {
    const entry = counts.get(s.classes) ?? { count: 0, files: new Set<string>() };
    entry.count++;
    entry.files.add(s.file);
    counts.set(s.classes, entry);
  }
  return [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
};

const computeElementConvention = (
  element: string,
  samples: Array<{ classes: string; file: string }>,
): ElementClassConvention | null => {
  if (samples.length < 3) return null;
  const ranked = rankClassSamples(samples);
  const [top, second] = ranked;
  const occurrences = top[1].count;
  const isLow = second !== undefined && second[1].count / occurrences >= 0.8;
  const confidence: 'high' | 'low' = isLow ? 'low' : 'high';
  return { element, modalClasses: top[0], occurrences, totalSamples: samples.length, confidence,
    files: [...top[1].files].slice(0, 3) };
};

const readFileContentOrNull = (filePath: string): string | null => {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
};

const accumulateSamples = (
  samplesMap: Map<string, Array<{ classes: string; file: string }>>,
  samples: Array<{ element: string; classes: string; file: string }>,
): void => {
  for (const s of samples) {
    const arr = samplesMap.get(s.element) ?? [];
    arr.push({ classes: s.classes, file: s.file });
    samplesMap.set(s.element, arr);
  }
};

const collectSamplesFromFile = (
  content: string,
  relPath: string,
): Array<{ element: string; classes: string; file: string }> => [
  ...extractHeadingClassSamples(content, relPath),
  ...extractGridGapSamples(content, relPath),
  ...extractGridColsSamples(content, relPath),
];

const collectClassSamples = (
  repoDir: string,
  candidateFiles: string[],
): Map<string, Array<{ classes: string; file: string }>> => {
  const samplesMap = new Map<string, Array<{ classes: string; file: string }>>();
  for (const filePath of candidateFiles) {
    const content = readFileContentOrNull(filePath);
    if (content === null) continue;
    accumulateSamples(samplesMap, collectSamplesFromFile(content, path.relative(repoDir, filePath)));
  }
  return samplesMap;
};

const applyGridColsSort = (conv: ElementClassConvention): ElementClassConvention =>
  ({ ...conv, modalClasses: sortByBreakpoint(conv.modalClasses.split(/\s+/)) });

const toElementConventions = (
  element: string,
  elementSamples: Array<{ classes: string; file: string }>,
): ElementClassConvention[] => {
  const conv = computeElementConvention(element, elementSamples);
  if (conv === null) return [];
  return element === 'grid-cols' ? [applyGridColsSort(conv)] : [conv];
};

const detectElementClassConventions = (
  repoDir: string, sourceRoots: string[], skipDirs: Set<string>
): ElementClassConvention[] => {
  const scanRoots = resolveUiPatternScanRoots(repoDir, sourceRoots);
  if (scanRoots.length === 0) return [];
  const candidateFiles = scanRoots.flatMap(root =>
    walkDir(root, filePath => elementClassExtensions.has(path.extname(filePath)), skipDirs),
  );
  const samplesMap = collectClassSamples(repoDir, candidateFiles);
  return [...samplesMap.entries()].flatMap(([element, s]) => toElementConventions(element, s));
};

const detectUiPatternExemplars = (
  repoDir: string, sourceRoots: string[], skipDirs: Set<string>
): UiPatternExemplar[] => {
  const scanRoots = resolveUiPatternScanRoots(repoDir, sourceRoots);
  if (scanRoots.length === 0) return [];

  const candidateFiles = scanRoots.flatMap(root =>
    walkDir(root, filePath => uiPatternsExtensions.has(path.extname(filePath)), skipDirs)
  );

  return uiPatternSignatures.map(signature => matchSignatureFiles(signature, candidateFiles, repoDir));
};

const detectComponentLibrary = (repoDir: string, keyDeps: string[]): DesignSystemContext['componentLibrary'] =>
  fs.existsSync(path.join(repoDir, 'components.json'))
    ? 'shadcn-ui'
    : componentLibraryDeps.find(dep => keyDeps.includes(dep)) ?? null;

const detectDesignSystemContext = (
  repoDir: string, keyDeps: string[], sourceRoots: string[], skipDirs: Set<string>
): DesignSystemContext => {
  const framework = resolveDesignSystemFramework(keyDeps), tailwindConfig = detectTailwindConfig(repoDir);
  const componentLib = detectComponentLibrary(repoDir, keyDeps);
  const patterns = detectUiPatternExemplars(repoDir, sourceRoots, skipDirs);
  const conventions = detectElementClassConventions(repoDir, sourceRoots, skipDirs);
  const hasUiEnv = !!(framework || componentLib || tailwindConfig || patterns.some(p => p.found) || conventions.length);
  return {
    framework, configFile: resolveDesignSystemConfigFile(repoDir, framework), tailwindConfig,
    darkModeConvention: detectDarkModeConvention(repoDir, tailwindConfig),
    componentLibrary: componentLib, hasStorybook: fs.existsSync(path.join(repoDir, '.storybook')),
    interactionPatterns: patterns, classConventions: conventions, hasUiEnvironment: hasUiEnv,
  };
};

const assembleConventions = (inputs: ConventionsInputs): RepoConventionsContext => {
  const { repoDir, hasGoMod, sourceRoots, allDeps, skipDirs } = inputs;
  const langContexts = detectLanguageContexts(inputs);
  const keyDependencies = detectKeyDependencies(allDeps, hasGoMod, repoDir, langContexts.terraform);

  return {
    language: inputs.language,
    ...langContexts,
    ...assembleStructuralConventions(inputs, langContexts),
    keyDependencies,
    errorHandlingPaths: detectErrorHandlingPaths(sourceRoots, repoDir, skipDirs),
    packageManager: detectPackageManager(repoDir),
    gitHooks: detectGitHooks(repoDir),
    designSystem: detectDesignSystemContext(repoDir, keyDependencies, sourceRoots, skipDirs),
  };
};

/**
 * Detect repository coding conventions from config files in the given directory.
 *
 * @param repoDir - Absolute path to the repository root
 * @returns A RepoConventionsContext snapshot; never throws
 */
export const detectRepoConventions = (repoDir: string): RepoConventionsContext => {
  const skipDirs = buildSkipDirs(repoDir);
  const { language, hasGoMod, hasTfFiles } = detectLanguage(repoDir);
  const sourceRoots = detectSourceRoots(repoDir, language);
  const { pkgDeps, pkgDevDeps, pkgType } = readPackageJson(repoDir);
  const allDeps = { ...pkgDeps, ...pkgDevDeps };

  return assembleConventions({ repoDir, language, hasGoMod, hasTfFiles, sourceRoots, allDeps, pkgType, skipDirs });
};

/**
 * Check whether a conventions context has meaningful data worth displaying.
 *
 * @param ctx - The conventions context
 * @returns True if at least one section has meaningful data
 */
export const hasMeaningfulConventionsData = (ctx: RepoConventionsContext): boolean =>
  ctx.linter !== null
  || ctx.formatter !== null
  || ctx.typescript !== null
  || ctx.go !== null
  || ctx.python !== null
  || ctx.terraform !== null
  || ctx.folderStructure.length > 0
  || ctx.nestjsDetected
  || ctx.keyDependencies.length > 0
  || ctx.errorHandlingPaths.length > 0
  || (ctx.designSystem?.componentLibrary !== null && ctx.designSystem?.componentLibrary !== undefined)
  || (ctx.designSystem?.interactionPatterns.some(p => p.found) ?? false)
  || (ctx.designSystem?.classConventions.some(c => c.confidence === 'high') ?? false)
  || ctx.gitHooks.some(hookCtx => Object.keys(hookCtx.hooks).length > 0);

/**
 * Wrap a detail string in parentheses, or yield an empty string when there is nothing to show.
 *
 * @param details - Pre-formatted detail text
 * @returns The parenthesised suffix, or an empty string
 */
const formatDetailSuffix = (details: string): string => (details ? ` (${details})` : '');

/**
 * Format rule entries into a comma-separated `key: value` string.
 *
 * @param entries - Rule name/value pairs
 * @returns Comma-separated rule summary
 */
const formatRuleEntries = (entries: Array<[string, unknown]>): string =>
  entries.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ');

/**
 * Format linter context into a prompt line.
 *
 * @param linter - Linter context
 * @returns Formatted linter line
 */
const formatLinterLine = (linter: NonNullable<RepoConventionsContext['linter']>): string => {
  const entries = Object.entries(linter.keyRules);
  const styleRules = formatRuleEntries(entries.filter(([key]) => !eslintStructuralRules.includes(key)));
  const structuralRules = formatRuleEntries(entries.filter(([key]) => eslintStructuralRules.includes(key)));
  const constraints = structuralRules ? `constraints: ${structuralRules}` : '';
  const details = [styleRules, constraints].filter(Boolean).join('; ');
  return `- Linter: ${linter.tool}${formatDetailSuffix(details)}`;
};

/**
 * Format formatter context into a prompt line.
 *
 * @param formatter - Formatter context
 * @returns Formatted formatter line
 */
const formatFormatterLine = (formatter: NonNullable<RepoConventionsContext['formatter']>): string => {
  const rules = formatRuleEntries(Object.entries(formatter.keyRules));
  return `- Formatter: ${formatter.tool}${formatDetailSuffix(rules)}`;
};

/**
 * Format TypeScript context into a prompt line.
 *
 * @param ts - TypeScript context
 * @returns Formatted TypeScript line
 */
const formatTypescriptLine = (ts: NonNullable<RepoConventionsContext['typescript']>): string => {
  const strictLabel = ts.strict ? 'strict mode' : 'non-strict';
  return `- TypeScript: ${strictLabel}, ${ts.module}, ${ts.target}`;
};

/**
 * Append Terraform-specific lines to the prompt output.
 *
 * @param tf - Terraform context
 * @param lines - Mutable array of output lines
 */
const appendTerraformLines = (tf: NonNullable<RepoConventionsContext['terraform']>, lines: string[]): void => {
  if (tf.providers.length > 0) lines.push(`- Terraform providers: ${tf.providers.join(', ')}`);
  if (tf.backend) lines.push(`- Terraform backend: ${tf.backend}`);
  if (tf.modulePaths.length > 0) lines.push(`- Terraform modules: ${tf.modulePaths.join(', ')}`);
};

/**
 * Format Python tooling context into a prompt line.
 *
 * @param python - Python context
 * @returns Formatted Python tooling line
 */
const formatPythonLine = (python: NonNullable<RepoConventionsContext['python']>): string => {
  const settings = Object.keys(python.keySettings).join(', ');
  return `- Python tooling: ${python.tool}${formatDetailSuffix(settings)}`;
};

/**
 * Append language-specific and tooling lines to the prompt output.
 *
 * @param ctx - The conventions context
 * @param lines - Mutable array of output lines
 */
const appendToolingLines = (ctx: RepoConventionsContext, lines: string[]): void => {
  lines.push(`- Package manager: ${ctx.packageManager}`);
  if (ctx.linter) lines.push(formatLinterLine(ctx.linter));
  if (ctx.formatter) lines.push(formatFormatterLine(ctx.formatter));
  if (ctx.typescript) lines.push(formatTypescriptLine(ctx.typescript));
  if (ctx.go) lines.push(`- Go module: ${ctx.go.modulePath}`);
  if (ctx.python) lines.push(formatPythonLine(ctx.python));
  if (ctx.terraform) appendTerraformLines(ctx.terraform, lines);
};

/**
 * Append structural and dependency lines to the prompt output.
 *
 * @param ctx - The conventions context
 * @param lines - Mutable array of output lines
 */
const appendStructureLines = (ctx: RepoConventionsContext, lines: string[]): void => {
  if (ctx.folderStructure.length > 0) lines.push(`- Folder structure: ${ctx.folderStructure.join(', ')}`);
  lines.push(`- Naming: ${ctx.namingPattern}`);
  if (ctx.nestjsDetected) lines.push('- Framework: NestJS');
  if (ctx.language === 'typescript' || ctx.language === 'javascript') lines.push(`- Import style: ${ctx.importStyle}`);
  if (ctx.keyDependencies.length > 0) lines.push(`- Key deps: ${ctx.keyDependencies.join(', ')}`);
  if (ctx.errorHandlingPaths.length > 0) lines.push(`- Error utilities: ${ctx.errorHandlingPaths.join(', ')}`);
  for (const hookCtx of ctx.gitHooks) {
    const hookLines = Object.entries(hookCtx.hooks)
      .map(([name, cmds]) => `  - ${name}: ${cmds.join(', ')}`)
      .join('\n');
    if (!hookLines) continue;
    lines.push(`- Git hooks (${hookCtx.tool}):\n${hookLines}`);
  }
};

const buildDesignSystemLine = (ds: DesignSystemContext): string => {
  const extras: string[] = [];
  if (ds.configFile) extras.push(ds.configFile);
  if (ds.tailwindConfig?.mode) extras.push(`tailwind:${ds.tailwindConfig.mode}`);
  if (ds.darkModeConvention) extras.push(ds.darkModeConvention);
  const suffix = extras.length ? ' (' + extras.join(', ') + ')' : '';
  return `- Design system: ${ds.framework ?? 'unknown'}/${ds.componentLibrary ?? 'none'}` + suffix;
};

const buildInteractionPatternLines = (patterns: UiPatternExemplar[]): string[] =>
  patterns
    .filter(p => p.found)
    .map(p => `  - ${p.pattern}: ${p.files.join(', ')}`);

const buildClassConventionLines = (conventions: ElementClassConvention[]): string[] => {
  const lines: string[] = [];
  for (const c of conventions) {
    if (c.confidence === 'high') {
      lines.push(`  - ${c.element}: "${c.modalClasses}" (${c.occurrences}/${c.totalSamples}, e.g. ${c.files.slice(0, 2).join(', ')})`);
    } else {
      lines.push(`  - ${c.element}: no consistent convention (${c.totalSamples} samples, top variants within 20%)`);
    }
  }
  return lines;
};

const appendDesignSystemLines = (ctx: RepoConventionsContext, lines: string[]): void => {
  if (!ctx.designSystem) return;
  lines.push(buildDesignSystemLine(ctx.designSystem));
  const patternLines = buildInteractionPatternLines(ctx.designSystem.interactionPatterns);
  if (patternLines.length > 0) {
    lines.push('- Known UI interaction patterns (match these before inventing a new approach):', ...patternLines);
  }
  const conventionLines = buildClassConventionLines(ctx.designSystem.classConventions ?? []);
  if (conventionLines.length > 0) {
    lines.push('- Element class conventions (cite these before choosing a class for the same element; a low-confidence line means no single winner — pick from the documented variants):', ...conventionLines);
  }
};

/**
 * Format a RepoConventionsContext into a prompt section string.
 *
 * @param ctx - The conventions context
 * @param repoName - Human-readable repository name
 * @param opts - Options; set `includeDesignSystem: false` to omit the design-system block
 * @returns A formatted string for inclusion in an AI prompt, or empty string when no meaningful data exists
 */
export const formatRepoConventionsPromptSection = (
  ctx: RepoConventionsContext,
  repoName: string,
  opts?: { includeDesignSystem?: boolean }
): string => {
  if (!hasMeaningfulConventionsData(ctx)) return '';
  const lines: string[] = [`Repository conventions (${repoName}):`];
  lines.push(`- Language: ${ctx.language}`);
  appendToolingLines(ctx, lines);
  appendStructureLines(ctx, lines);
  if (opts?.includeDesignSystem !== false) appendDesignSystemLines(ctx, lines);
  return lines.join('\n');
};
