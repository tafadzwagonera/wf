import * as fs from 'fs';
import * as path from 'path';

export interface RepoConventionsContext {
  linter: { tool: string; keyRules: Record<string, unknown> } | null;
  typescript: {
    strict: boolean;
    module: string;
    target: string;
    paths: Record<string, string[]>;
  } | null;
  folderStructure: string[];
  namingPattern: 'camelCase' | 'kebab-case' | 'PascalCase' | 'mixed';
  nestjsDetected: boolean;
  importStyle: 'commonjs' | 'esm' | 'unknown';
  keyDependencies: string[];
  errorHandlingPaths: string[];
}

const KEY_DEPENDENCY_KEYWORDS = [
  '@nestjs/core',
  'express',
  'fastify',
  'react',
  'next',
  'angular',
  'vue',
  'jest',
  'vitest',
  'mocha',
];

/**
 * Classify a list of filenames into a naming pattern.
 *
 * @param names - File base names (without extension)
 * @returns The detected naming pattern
 */
const classifyNamingPattern = (
  names: string[],
): 'camelCase' | 'kebab-case' | 'PascalCase' | 'mixed' => {
  if (names.length === 0) return 'mixed';

  let camelCount = 0;
  let kebabCount = 0;
  let pascalCount = 0;

  for (const name of names) {
    if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) {
      pascalCount++;
    } else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) {
      camelCount++;
    } else if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(name)) {
      kebabCount++;
    }
  }

  const total = camelCount + kebabCount + pascalCount;
  if (total === 0) return 'mixed';

  const dominant = Math.max(camelCount, kebabCount, pascalCount);
  const dominantRatio = dominant / names.length;

  if (dominantRatio < 0.6) return 'mixed';

  if (dominant === camelCount) return 'camelCase';
  if (dominant === kebabCount) return 'kebab-case';
  return 'PascalCase';
};

/**
 * Recursively walk a directory collecting file paths that match a predicate.
 *
 * @param dir - Absolute directory path to walk
 * @param predicate - Function returning true for paths to include
 * @returns Array of matching absolute file paths
 */
const walkDir = (
  dir: string,
  predicate: (filePath: string) => boolean,
): string[] => {
  const results: string[] = [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, predicate));
    } else if (predicate(fullPath)) {
      results.push(fullPath);
    }
  }

  return results;
};

/**
 * Detect repository coding conventions from config files in the given directory.
 *
 * @param repoDir - Absolute path to the repository root
 * @returns A RepoConventionsContext snapshot; never throws
 */
export const detectRepoConventions = (
  repoDir: string,
): RepoConventionsContext => {
  // --- Linter ---
  let linter: RepoConventionsContext['linter'] = null;

  const eslintCandidates = [
    '.eslintrc',
    '.eslintrc.js',
    '.eslintrc.json',
    '.eslintrc.yml',
    '.eslintrc.yaml',
  ];
  const prettierCandidates = [
    '.prettierrc',
    '.prettierrc.js',
    '.prettierrc.json',
    '.prettierrc.yml',
    '.prettierrc.yaml',
  ];
  const biomeCandidates = ['biome.json'];

  const findFirst = (candidates: string[]): string | null => {
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(repoDir, candidate))) return candidate;
    }
    return null;
  };

  const eslintFile = findFirst(eslintCandidates);
  const prettierFile = findFirst(prettierCandidates);
  const biomeFile = findFirst(biomeCandidates);

  const parseJsonLike = (filePath: string): Record<string, unknown> => {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  const extractLinterRules = (
    tool: string,
    filePath: string,
  ): { tool: string; keyRules: Record<string, unknown> } => {
    const parsed = parseJsonLike(filePath);
    const keyRules: Record<string, unknown> = {};

    if (tool === 'eslint') {
      const rules = (parsed['rules'] as Record<string, unknown>) ?? {};
      const semi = rules['semi'];
      const quotes = rules['quotes'];
      const trailingComma = rules['comma-dangle'] ?? rules['trailingComma'];
      if (semi !== undefined) keyRules['semi'] = semi;
      if (quotes !== undefined) keyRules['quotes'] = quotes;
      if (trailingComma !== undefined)
        keyRules['trailingComma'] = trailingComma;
    }

    if (tool === 'prettier') {
      if (parsed['semi'] !== undefined) keyRules['semi'] = parsed['semi'];
      if (parsed['singleQuote'] !== undefined)
        keyRules['singleQuote'] = parsed['singleQuote'];
      if (parsed['trailingComma'] !== undefined)
        keyRules['trailingComma'] = parsed['trailingComma'];
    }

    if (tool === 'biome') {
      const linterSection = (parsed['linter'] as Record<string, unknown>) ?? {};
      if (linterSection['rules'] !== undefined)
        keyRules['rules'] = linterSection['rules'];
      const formatterSection =
        (parsed['formatter'] as Record<string, unknown>) ?? {};
      if (formatterSection['indentStyle'] !== undefined)
        keyRules['indentStyle'] = formatterSection['indentStyle'];
    }

    return { tool, keyRules };
  };

  if (eslintFile) {
    linter = extractLinterRules('eslint', path.join(repoDir, eslintFile));
  } else if (prettierFile) {
    linter = extractLinterRules('prettier', path.join(repoDir, prettierFile));
  } else if (biomeFile) {
    linter = extractLinterRules('biome', path.join(repoDir, biomeFile));
  }

  // --- TypeScript ---
  let typescript: RepoConventionsContext['typescript'] = null;
  const tsconfigPath = path.join(repoDir, 'tsconfig.json');

  if (fs.existsSync(tsconfigPath)) {
    try {
      const raw = fs.readFileSync(tsconfigPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const compilerOptions =
        (parsed['compilerOptions'] as Record<string, unknown>) ?? {};
      const moduleVal = compilerOptions['module'];
      const targetVal = compilerOptions['target'];
      typescript = {
        strict: compilerOptions['strict'] === true,
        module: typeof moduleVal === 'string' ? moduleVal : 'commonjs',
        target: typeof targetVal === 'string' ? targetVal : 'ES5',
        paths: (compilerOptions['paths'] as Record<string, string[]>) ?? {},
      };
    } catch {
      // leave typescript as null
    }
  }

  // --- Folder structure ---
  const folderStructure: string[] = [];
  const srcDir = path.join(repoDir, 'src');

  if (fs.existsSync(srcDir)) {
    try {
      const entries = fs.readdirSync(srcDir, {
        withFileTypes: true,
      });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          folderStructure.push(entry.name);
        }
      }
    } catch {
      // leave empty
    }
  }

  // --- Naming pattern ---
  let namingPattern: RepoConventionsContext['namingPattern'] = 'mixed';

  if (fs.existsSync(srcDir)) {
    try {
      const entries = fs.readdirSync(srcDir, {
        withFileTypes: true,
      });
      const fileNames = entries
        .filter((e) => !e.isDirectory())
        .map((e) => path.basename(e.name, path.extname(e.name)));
      namingPattern = classifyNamingPattern(fileNames);
    } catch {
      // leave as mixed
    }
  }

  // --- Package.json ---
  let pkgDeps: Record<string, string> = {};
  let pkgDevDeps: Record<string, string> = {};
  let pkgType: string | undefined;
  const pkgPath = path.join(repoDir, 'package.json');

  if (fs.existsSync(pkgPath)) {
    try {
      const raw = fs.readFileSync(pkgPath, 'utf-8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      pkgDeps = (parsed['dependencies'] as Record<string, string>) ?? {};
      pkgDevDeps = (parsed['devDependencies'] as Record<string, string>) ?? {};
      pkgType = parsed['type'] as string | undefined;
    } catch {
      // leave empty
    }
  }

  const allDeps = { ...pkgDeps, ...pkgDevDeps };

  // --- NestJS detected ---
  const nestjsDetected = '@nestjs/core' in allDeps;

  // --- Import style ---
  let importStyle: RepoConventionsContext['importStyle'] = 'unknown';

  if (typescript) {
    const mod = typescript.module.toLowerCase();
    if (mod.includes('commonjs')) {
      importStyle = 'commonjs';
    } else if (
      mod.includes('esm') ||
      mod.includes('esnext') ||
      mod.includes('es2015') ||
      mod === 'nodenext' ||
      mod === 'node16'
    ) {
      importStyle = 'esm';
    }
  }

  if (importStyle === 'unknown' && pkgType) {
    if (pkgType === 'module') importStyle = 'esm';
    else if (pkgType === 'commonjs') importStyle = 'commonjs';
  }

  // --- Key dependencies ---
  const keyDependencies = KEY_DEPENDENCY_KEYWORDS.filter((kw) => kw in allDeps);

  // --- Error handling paths ---
  const errorHandlingPaths: string[] = [];

  if (fs.existsSync(srcDir)) {
    const matches = walkDir(srcDir, (filePath) => {
      const base = path.basename(filePath).toLowerCase();
      return base.includes('error') || base.includes('exception');
    });
    errorHandlingPaths.push(...matches);
  }

  return {
    linter,
    typescript,
    folderStructure,
    namingPattern,
    nestjsDetected,
    importStyle,
    keyDependencies,
    errorHandlingPaths,
  };
};

/**
 * Format a RepoConventionsContext into a prompt section string.
 *
 * @param ctx - The conventions context
 * @param repoName - Human-readable repository name
 * @returns A formatted string for inclusion in an AI prompt, or empty string when no meaningful data exists
 */
export const formatRepoConventionsPromptSection = (
  ctx: RepoConventionsContext,
  repoName: string,
): string => {
  const hasMeaningfulData =
    ctx.linter !== null ||
    ctx.typescript !== null ||
    ctx.folderStructure.length > 0 ||
    ctx.nestjsDetected ||
    ctx.keyDependencies.length > 0 ||
    ctx.errorHandlingPaths.length > 0;

  if (!hasMeaningfulData) return '';

  const lines: string[] = [`Repository conventions (${repoName}):`];

  if (ctx.linter) {
    const ruleStr = Object.entries(ctx.linter.keyRules)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');
    lines.push(`- Linter: ${ctx.linter.tool}${ruleStr ? ` (${ruleStr})` : ''}`);
  }

  if (ctx.typescript) {
    const strictLabel = ctx.typescript.strict ? 'strict mode' : 'non-strict';
    lines.push(
      `- TypeScript: ${strictLabel}, ${ctx.typescript.module}, ${ctx.typescript.target}`,
    );
  }

  if (ctx.folderStructure.length > 0) {
    lines.push(`- Folder structure: ${ctx.folderStructure.join(', ')}`);
  }

  lines.push(`- Naming: ${ctx.namingPattern}`);

  if (ctx.nestjsDetected) {
    lines.push('- Framework: NestJS');
  }

  lines.push(`- Import style: ${ctx.importStyle}`);

  if (ctx.keyDependencies.length > 0) {
    lines.push(`- Key deps: ${ctx.keyDependencies.join(', ')}`);
  }

  if (ctx.errorHandlingPaths.length > 0) {
    lines.push(`- Error utilities: ${ctx.errorHandlingPaths.join(', ')}`);
  }

  return lines.join('\n');
};
