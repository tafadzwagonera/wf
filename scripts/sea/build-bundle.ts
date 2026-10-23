import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { build, type BuildResult, type Metafile } from 'esbuild';

const rootDir = path.join(__dirname, '..', '..');
const outFile = path.join(rootDir, 'dist-bundle', 'wf.cjs');
const optionalNestPackages = ['@nestjs/microservices*', '@nestjs/websockets*'];
const optionalRuntimeRequires = new Set([
  'file-type',
  'encoding',
  'bufferutil',
  'utf-8-validate',
  '@nestjs/websockets/socket-module',
  '@nestjs/microservices/microservices-module',
  '@nestjs/microservices',
  'repl',
]);
const importMetaUrlBanner = 'const __wfImportMetaUrl = require("node:url").pathToFileURL(__filename).href;';

const findNativeAddons = (metafile: Metafile): string[] =>
  Object.keys(metafile.inputs).filter(input => input.endsWith('.node'));

const isBuiltin = (specifier: string): boolean =>
  specifier.startsWith('node:') || builtinModules.includes(specifier);

const findUnresolvedDynamicRequires = (metafile: Metafile): string[] =>
  Object.values(metafile.outputs)
    .flatMap(output => output.imports)
    .filter(imported => imported.external && imported.kind !== 'import-statement')
    .map(imported => imported.path)
    .filter(specifier => !isBuiltin(specifier) && !optionalRuntimeRequires.has(specifier));

const bundle = (): Promise<BuildResult & { metafile: Metafile }> =>
  build({
    entryPoints: [path.join(__dirname, 'sea-entry.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    metafile: true,
    logLevel: 'warning',
    banner: { js: importMetaUrlBanner },
    define: { 'import.meta.url': '__wfImportMetaUrl' },
    external: ['node:sea', ...optionalNestPackages],
  });

const assertBundleIsSelfContained = (metafile: Metafile): void => {
  const unresolvedRequires = findUnresolvedDynamicRequires(metafile);
  if (unresolvedRequires.length > 0) {
    throw new Error(`Unresolved dynamic requires in the SEA bundle: ${unresolvedRequires.join(', ')}`);
  }
  const nativeAddons = findNativeAddons(metafile);
  if (nativeAddons.length > 0) {
    throw new Error(`Native addons cannot be embedded in the SEA bundle: ${nativeAddons.join(', ')}`);
  }
  const hasAgentSdk = Object.keys(metafile.inputs).some(input => input.includes('claude-agent-sdk'));
  if (!hasAgentSdk) throw new Error('@anthropic-ai/claude-agent-sdk was left external in the SEA bundle');
};

const run = async (): Promise<void> => {
  const { metafile, warnings } = await bundle();
  if (warnings.length > 0) {
    throw new Error(`Unresolved or unsafe requires in the SEA bundle: ${warnings.map(w => w.text).join('; ')}`);
  }
  assertBundleIsSelfContained(metafile);
  fs.writeFileSync(path.join(rootDir, 'dist-bundle', 'metafile.json'), JSON.stringify(metafile));
  console.log(`Bundled ${Object.keys(metafile.inputs).length} inputs into ${outFile}`);
};

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
