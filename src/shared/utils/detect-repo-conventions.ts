import * as fs from 'fs';
import * as path from 'path';

export type RepoLanguage = 'typescript' | 'javascript' | 'go' | 'python' | 'terraform' | 'unknown';

export interface RepoConventionsContext {
  language: RepoLanguage;
  linter: { tool: string; keyRules: Record<string, unknown> } | null;
  typescript: {
    strict: boolean;
    module: string;
    target: string;
    paths: Record<string, string[]>;
  } | null;
  go: { modulePath: string } | null;
  python: { tool: string; keySettings: Record<string, unknown> } | null;
  terraform: {
    providers: string[];
    backend: string | null;
    modulePaths: string[];
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
const classifyNamingPattern = (names: string[]): 'camelCase' | 'kebab-case' | 'PascalCase' | 'mixed' => {
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
const walkDir = (dir: string, predicate: (filePath: string) => boolean): string[] => {
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
export const detectRepoConventions = (repoDir: string): RepoConventionsContext => {
  // --- Language detection ---
  const hasTsConfig = fs.existsSync(path.join(repoDir, 'tsconfig.json'));
  const hasPkgJson = fs.existsSync(path.join(repoDir, 'package.json'));
  const hasGoMod = fs.existsSync(path.join(repoDir, 'go.mod'));
  const hasPyProject = fs.existsSync(path.join(repoDir, 'pyproject.toml'));
  const hasSetupPy = fs.existsSync(path.join(repoDir, 'setup.py'));
  const hasRequirementsTxt = fs.existsSync(path.join(repoDir, 'requirements.txt'));
  const hasTfFiles = (() => {
    try {
      const entries = fs.readdirSync(repoDir);
      return entries.some(e => e.endsWith('.tf'));
    } catch {
      return false;
    }
  })();

  let language: RepoLanguage = 'unknown';
  if (hasTsConfig) language = 'typescript';
  else if (hasPkgJson) language = 'javascript';
  else if (hasGoMod) language = 'go';
  else if (hasPyProject || hasSetupPy || hasRequirementsTxt) language = 'python';
  else if (hasTfFiles) language = 'terraform';

  // --- Go module ---
  let goCtx: RepoConventionsContext['go'] = null;
  if (hasGoMod) {
    try {
      const raw = fs.readFileSync(path.join(repoDir, 'go.mod'), 'utf-8');
      const moduleMatch = raw.match(/^module\s+(\S+)/m);
      goCtx = { modulePath: moduleMatch ? moduleMatch[1] : '' };
    } catch {
      // leave null
    }
  }

  // --- Python tooling ---
  let pythonCtx: RepoConventionsContext['python'] = null;
  if (language === 'python') {
    const pyLinters: Array<{
      file: string;
      tool: string;
      extract: (raw: string) => Record<string, unknown>;
    }> = [
      {
        file: 'pyproject.toml',
        tool: 'pyproject',
        extract: raw => {
          const settings: Record<string, unknown> = {};
          const ruffMatch = raw.match(/\[tool\.ruff\]/);
          if (ruffMatch) settings['ruff'] = true;
          const blackMatch = raw.match(/\[tool\.black\]/);
          if (blackMatch) settings['black'] = true;
          const mypyMatch = raw.match(/\[tool\.mypy\]/);
          if (mypyMatch) settings['mypy'] = true;
          const pytestMatch = raw.match(/\[tool\.pytest/);
          if (pytestMatch) settings['pytest'] = true;
          return settings;
        },
      },
      {
        file: '.flake8',
        tool: 'flake8',
        extract: () => ({}),
      },
      {
        file: 'setup.cfg',
        tool: 'setup.cfg',
        extract: () => ({}),
      },
    ];

    for (const candidate of pyLinters) {
      const pyPath = path.join(repoDir, candidate.file);
      if (fs.existsSync(pyPath)) {
        try {
          const raw = fs.readFileSync(pyPath, 'utf-8');
          pythonCtx = {
            tool: candidate.tool,
            keySettings: candidate.extract(raw),
          };
          break;
        } catch {
          // try next
        }
      }
    }
  }

  // --- Terraform ---
  let terraformCtx: RepoConventionsContext['terraform'] = null;
  if (hasTfFiles) {
    const providers: string[] = [];
    let backend: string | null = null;
    const modulePaths: string[] = [];

    try {
      const entries = fs.readdirSync(repoDir);
      for (const entry of entries) {
        if (!entry.endsWith('.tf')) continue;
        try {
          const raw = fs.readFileSync(path.join(repoDir, entry), 'utf-8');
          const providerMatches = raw.matchAll(/provider\s+"([^"]+)"/g);
          for (const m of providerMatches) {
            if (!providers.includes(m[1])) providers.push(m[1]);
          }
          const backendMatch = raw.match(/backend\s+"([^"]+)"/);
          if (backendMatch) backend = backendMatch[1];
        } catch {
          // skip unreadable .tf file
        }
      }
    } catch {
      // leave empty
    }

    // Scan for module directories (contain .tf files)
    const scanModules = (dir: string, prefix: string): void => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const subDir = path.join(dir, entry.name);
          try {
            const subEntries = fs.readdirSync(subDir);
            if (subEntries.some(e => e.endsWith('.tf'))) {
              modulePaths.push(prefix ? `${prefix}/${entry.name}` : entry.name);
            }
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }
    };

    const modulesDir = path.join(repoDir, 'modules');
    if (fs.existsSync(modulesDir)) {
      scanModules(modulesDir, 'modules');
    }

    terraformCtx = { providers, backend, modulePaths };
  }

  // --- Linter ---
  let linter: RepoConventionsContext['linter'] = null;

  const eslintCandidates = ['.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.yml', '.eslintrc.yaml'];
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

  const extractLinterRules = (tool: string, filePath: string): { tool: string; keyRules: Record<string, unknown> } => {
    const parsed = parseJsonLike(filePath);
    const keyRules: Record<string, unknown> = {};

    if (tool === 'eslint') {
      const rules = (parsed['rules'] as Record<string, unknown>) ?? {};
      const semi = rules['semi'];
      const quotes = rules['quotes'];
      const trailingComma = rules['comma-dangle'] ?? rules['trailingComma'];
      if (semi !== undefined) keyRules['semi'] = semi;
      if (quotes !== undefined) keyRules['quotes'] = quotes;
      if (trailingComma !== undefined) keyRules['trailingComma'] = trailingComma;
    }

    if (tool === 'prettier') {
      if (parsed['semi'] !== undefined) keyRules['semi'] = parsed['semi'];
      if (parsed['singleQuote'] !== undefined) keyRules['singleQuote'] = parsed['singleQuote'];
      if (parsed['trailingComma'] !== undefined) keyRules['trailingComma'] = parsed['trailingComma'];
    }

    if (tool === 'biome') {
      const linterSection = (parsed['linter'] as Record<string, unknown>) ?? {};
      if (linterSection['rules'] !== undefined) keyRules['rules'] = linterSection['rules'];
      const formatterSection = (parsed['formatter'] as Record<string, unknown>) ?? {};
      if (formatterSection['indentStyle'] !== undefined) keyRules['indentStyle'] = formatterSection['indentStyle'];
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
      const compilerOptions = (parsed['compilerOptions'] as Record<string, unknown>) ?? {};
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

  // Pick the conventional source root per language
  const sourceRoots: string[] = [];
  if (language === 'go') {
    for (const d of ['cmd', 'pkg', 'internal', 'api']) {
      if (fs.existsSync(path.join(repoDir, d))) sourceRoots.push(path.join(repoDir, d));
    }
  } else if (language === 'terraform') {
    for (const d of ['modules', 'environments', 'stacks']) {
      if (fs.existsSync(path.join(repoDir, d))) sourceRoots.push(path.join(repoDir, d));
    }
  } else if (language === 'python') {
    const srcDir = path.join(repoDir, 'src');
    if (fs.existsSync(srcDir)) {
      sourceRoots.push(srcDir);
    } else {
      // Python repos often use the package name directly at root
      try {
        const rootEntries = fs.readdirSync(repoDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (
            entry.isDirectory() &&
            !entry.name.startsWith('.') &&
            !['node_modules', '__pycache__', '.git', 'venv', '.venv'].includes(entry.name) &&
            fs.existsSync(path.join(repoDir, entry.name, '__init__.py'))
          ) {
            sourceRoots.push(path.join(repoDir, entry.name));
            break;
          }
        }
      } catch {
        // leave empty
      }
    }
  } else {
    const srcDir = path.join(repoDir, 'src');
    if (fs.existsSync(srcDir)) sourceRoots.push(srcDir);
  }

  for (const root of sourceRoots) {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const label = sourceRoots.length > 1 ? `${path.basename(root)}/${entry.name}` : entry.name;
          folderStructure.push(label);
        }
      }
    } catch {
      // leave empty
    }
  }

  // For Go and Terraform at the root level, also list top-level dirs
  if (sourceRoots.length === 0 && (language === 'go' || language === 'terraform')) {
    try {
      const rootEntries = fs.readdirSync(repoDir, { withFileTypes: true });
      for (const entry of rootEntries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          folderStructure.push(entry.name);
        }
      }
    } catch {
      // leave empty
    }
  }

  // --- Naming pattern ---
  let namingPattern: RepoConventionsContext['namingPattern'] = 'mixed';

  const namingScanDir = sourceRoots[0] ?? path.join(repoDir, 'src');
  if (fs.existsSync(namingScanDir)) {
    try {
      const entries = fs.readdirSync(namingScanDir, {
        withFileTypes: true,
      });
      const fileNames = entries.filter(e => !e.isDirectory()).map(e => path.basename(e.name, path.extname(e.name)));
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
  const keyDependencies = KEY_DEPENDENCY_KEYWORDS.filter(kw => kw in allDeps);

  // Go dependencies (from go.mod require block)
  if (hasGoMod) {
    try {
      const raw = fs.readFileSync(path.join(repoDir, 'go.mod'), 'utf-8');
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
      for (const dep of goKeyDeps) {
        if (raw.includes(dep)) keyDependencies.push(path.basename(dep));
      }
    } catch {
      // skip
    }
  }

  // Terraform providers as dependencies
  if (terraformCtx) {
    for (const provider of terraformCtx.providers) {
      keyDependencies.push(`terraform-provider-${provider}`);
    }
  }

  // --- Error handling paths ---
  const errorHandlingPaths: string[] = [];

  const errorScanRoots =
    sourceRoots.length > 0 ? sourceRoots : fs.existsSync(path.join(repoDir, 'src')) ? [path.join(repoDir, 'src')] : [];

  for (const root of errorScanRoots) {
    const matches = walkDir(root, filePath => {
      const base = path.basename(filePath).toLowerCase();
      return base.includes('error') || base.includes('exception');
    });
    errorHandlingPaths.push(...matches);
  }

  return {
    language,
    linter,
    typescript,
    go: goCtx,
    python: pythonCtx,
    terraform: terraformCtx,
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
export const formatRepoConventionsPromptSection = (ctx: RepoConventionsContext, repoName: string): string => {
  const hasMeaningfulData =
    ctx.linter !== null ||
    ctx.typescript !== null ||
    ctx.go !== null ||
    ctx.python !== null ||
    ctx.terraform !== null ||
    ctx.folderStructure.length > 0 ||
    ctx.nestjsDetected ||
    ctx.keyDependencies.length > 0 ||
    ctx.errorHandlingPaths.length > 0;

  if (!hasMeaningfulData) return '';

  const lines: string[] = [`Repository conventions (${repoName}):`];

  lines.push(`- Language: ${ctx.language}`);

  if (ctx.linter) {
    const ruleStr = Object.entries(ctx.linter.keyRules)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join(', ');
    lines.push(`- Linter: ${ctx.linter.tool}${ruleStr ? ` (${ruleStr})` : ''}`);
  }

  if (ctx.typescript) {
    const strictLabel = ctx.typescript.strict ? 'strict mode' : 'non-strict';
    lines.push(`- TypeScript: ${strictLabel}, ${ctx.typescript.module}, ${ctx.typescript.target}`);
  }

  if (ctx.go) {
    lines.push(`- Go module: ${ctx.go.modulePath}`);
  }

  if (ctx.python) {
    const settingsStr = Object.keys(ctx.python.keySettings).join(', ');
    lines.push(`- Python tooling: ${ctx.python.tool}${settingsStr ? ` (${settingsStr})` : ''}`);
  }

  if (ctx.terraform) {
    if (ctx.terraform.providers.length > 0) {
      lines.push(`- Terraform providers: ${ctx.terraform.providers.join(', ')}`);
    }
    if (ctx.terraform.backend) {
      lines.push(`- Terraform backend: ${ctx.terraform.backend}`);
    }
    if (ctx.terraform.modulePaths.length > 0) {
      lines.push(`- Terraform modules: ${ctx.terraform.modulePaths.join(', ')}`);
    }
  }

  if (ctx.folderStructure.length > 0) {
    lines.push(`- Folder structure: ${ctx.folderStructure.join(', ')}`);
  }

  lines.push(`- Naming: ${ctx.namingPattern}`);

  if (ctx.nestjsDetected) {
    lines.push('- Framework: NestJS');
  }

  if (ctx.language === 'typescript' || ctx.language === 'javascript') {
    lines.push(`- Import style: ${ctx.importStyle}`);
  }

  if (ctx.keyDependencies.length > 0) {
    lines.push(`- Key deps: ${ctx.keyDependencies.join(', ')}`);
  }

  if (ctx.errorHandlingPaths.length > 0) {
    lines.push(`- Error utilities: ${ctx.errorHandlingPaths.join(', ')}`);
  }

  return lines.join('\n');
};
