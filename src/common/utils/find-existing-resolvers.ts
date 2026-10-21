import * as childProcess from 'node:child_process';
import { appendToLogFile } from '../logger/log-file-writer';

export type Cluster = { file: string; line: number; count: number };
export type Reader = { file: string; line: number; name: string };

type Hit = { file: string; line: number; text: string };

const GIT_TIMEOUT_IN_MS = 5000;
const MAX_BUFFER_IN_BYTES = 4 * 1024 * 1024;
const MAX_TERMS = 10;
const CLUSTER_WINDOW_IN_LINES = 15;
const LOG_CONTEXT = 'find-existing-resolvers';
const SAFE_TERM_PATTERN = /^\w+$/;
const HIT_LINE_PATTERN = /^(.+?):(\d+):(.*)$/;
const GIT_NO_MATCH_EXIT_CODE = 1;

const configReadPattern = (leaf: string): string =>
  `\\.get(<[^>]*>)?\\([[:space:]]*[\`'"][^\`'"]*\\.${leaf}[\`'"]`;

const DEFINITION_KEYWORDS = 'const|function|private|async';

const functionPattern = (names: string[]): string =>
  `(${DEFINITION_KEYWORDS})[[:space:]]+(${names.join('|')})([^[:alnum:]_]|$)`;

const definesFunction = (text: string, name: string): boolean =>
  new RegExp(`(?:${DEFINITION_KEYWORDS})\\s+${name}(?:\\W|$)`).test(text);

const safeTerms = (terms: string[]): string[] =>
  terms.filter(term => SAFE_TERM_PATTERN.test(term)).slice(0, MAX_TERMS);

const parseHits = (stdout: string): Hit[] =>
  stdout.split('\n').flatMap(rawLine => {
    const match = HIT_LINE_PATTERN.exec(rawLine);
    return match ? [{ file: match[1], line: Number(match[2]), text: match[3] }] : [];
  });

const isNoMatchExit = (error: unknown): boolean =>
  (error as { code?: unknown }).code === GIT_NO_MATCH_EXIT_CODE;

export const gitRunner = {
  run: (repoDir: string, args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      childProcess.execFile(
        'git',
        args,
        { cwd: repoDir, timeout: GIT_TIMEOUT_IN_MS, maxBuffer: MAX_BUFFER_IN_BYTES },
        (error, stdout) => error
          ? reject(Object.assign(new Error(error.message), { code: error.code }))
          : resolve(String(stdout))
      );
    }),
};

const gitGrep = async (repoDir: string, pattern: string): Promise<Hit[]> => {
  try {
    const stdout = await gitRunner.run(
      repoDir,
      ['grep', '-n', '-I', '-E', '--untracked', '-e', pattern, '--', 'src', ':!*.spec.ts']
    );
    return parseHits(stdout);
  } catch (error) {
    if (isNoMatchExit(error)) return [];
    const message = error instanceof Error ? error.message : String(error);
    appendToLogFile('DEBUG', `find-existing-resolvers.git_grep_failed error=${message.replaceAll('\n', ' | ')}`, LOG_CONTEXT);
    return [];
  }
};

const groupByFile = (hits: Hit[]): Map<string, number[]> =>
  hits.reduce((groups, hit) => {
    groups.set(hit.file, [...(groups.get(hit.file) ?? []), hit.line]);
    return groups;
  }, new Map<string, number[]>());

const firstClusterIn = (file: string, lines: number[]): Cluster | undefined => {
  const sorted = [...lines].sort((a, b) => a - b);
  const start = sorted.findIndex((line, index) => sorted[index + 1] - line <= CLUSTER_WINDOW_IN_LINES);
  if (start === -1) return undefined;
  let end = start;
  while (sorted[end + 1] - sorted[end] <= CLUSTER_WINDOW_IN_LINES) end += 1;
  return { file, line: sorted[start], count: end - start + 1 };
};

export const findConfigReadClusters = async (repoDir: string, leaves: string[]): Promise<Cluster[]> => {
  const clusters = await Promise.all(safeTerms(leaves).map(async leaf => {
    const groups = groupByFile(await gitGrep(repoDir, configReadPattern(leaf)));
    return [...groups.entries()].flatMap(([file, lines]) => firstClusterIn(file, lines) ?? []);
  }));
  return clusters.flat();
};

export const findFunctionsByName = async (repoDir: string, names: string[]): Promise<Reader[]> => {
  const terms = safeTerms(names);
  if (terms.length === 0) return [];
  const hits = await gitGrep(repoDir, functionPattern(terms));
  return hits.flatMap(hit => {
    const name = terms.find(term => definesFunction(hit.text, term));
    return name ? [{ file: hit.file, line: hit.line, name }] : [];
  });
};
