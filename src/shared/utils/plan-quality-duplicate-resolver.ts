import type { ResolutionPlan } from '../types/ai.types';
import { findConfigReadClusters, findFunctionsByName } from './find-existing-resolvers';
import { buildPlannedPathSet } from './planned-paths';
import type { PlanQualityViolation } from './plan-quality';

interface DetectDuplicateResolverParams {
  steps: string[];
  affectedFiles?: ResolutionPlan['affectedFiles'];
  affectedRepositories?: string[];
  repoDir?: string;
}

export const DUPLICATE_RESOLVER_RULE_ID = 'duplicate-resolver';
const MAX_LOOKUP_TERMS = 10;
const QUOTED_TOKEN_PATTERN = /`([^`]+)`|'([^']+)'|"([^"]+)"/g;
const CONFIG_KEY_PATTERN = /^(?:ai|stages|git|figma)\.[\w.]+$/;
const NEW_FUNCTION_VERB_PATTERN = /\b(add|create|new)/;
const resolverNamePrefixes = ['resolve', 'get', 'pick', 'select', 'build'];

const unique = (values: string[]): string[] => [...new Set(values)];

const quotedTokens = (step: string): string[] =>
  [...step.matchAll(QUOTED_TOKEN_PATTERN)].map(match => match[1] ?? match[2] ?? match[3]);

const configKeysIn = (steps: string[]): string[] =>
  unique(steps.flatMap(quotedTokens).filter(token => CONFIG_KEY_PATTERN.test(token)));

const isResolverName = (token: string): boolean =>
  resolverNamePrefixes.some(prefix => token.toLowerCase().startsWith(prefix));

const newFunctionNamesIn = (steps: string[]): string[] =>
  unique(
    steps
      .filter(step => NEW_FUNCTION_VERB_PATTERN.test(step.toLowerCase()))
      .flatMap(quotedTokens)
      .filter(isResolverName)
  );

const leafOf = (key: string): string => key.split('.').at(-1) ?? key;

const sharedLeaves = (keys: string[]): string[] => {
  const keysByLeaf = keys.reduce((groups, key) => {
    groups.set(leafOf(key), [...(groups.get(leafOf(key)) ?? []), key]);
    return groups;
  }, new Map<string, string[]>());
  return [...keysByLeaf.entries()].filter(([, group]) => group.length >= 2).map(([leaf]) => leaf);
};

const reuseMessage = (target: string, file: string, line: number): string =>
  `reuse ${target} in ${file}:${line}, or state why it cannot be reused`;

const violation = (message: string): PlanQualityViolation => ({ ruleId: DUPLICATE_RESOLVER_RULE_ID, message });

const detectConfigDuplicates = async (
  steps: string[], repoDir: string, plannedPaths: Set<string>
): Promise<PlanQualityViolation[]> => {
  const leaves = sharedLeaves(configKeysIn(steps)).slice(0, MAX_LOOKUP_TERMS);
  if (leaves.length === 0) return [];
  const clusters = await findConfigReadClusters(repoDir, leaves);
  const existing = clusters.find(cluster => !plannedPaths.has(cluster.file));
  return existing ? [violation(reuseMessage('the existing resolver', existing.file, existing.line))] : [];
};

const detectNameDuplicates = async (
  steps: string[], repoDir: string, plannedPaths: Set<string>
): Promise<PlanQualityViolation[]> => {
  const names = newFunctionNamesIn(steps).slice(0, MAX_LOOKUP_TERMS);
  if (names.length === 0) return [];
  const readers = await findFunctionsByName(repoDir, names);
  return readers
    .filter(reader => !plannedPaths.has(reader.file))
    .map(reader => violation(reuseMessage(reader.name, reader.file, reader.line)));
};

export const detectDuplicateResolverViolations = async (
  params: DetectDuplicateResolverParams
): Promise<PlanQualityViolation[]> => {
  const { steps, affectedFiles, affectedRepositories, repoDir } = params;
  if (!repoDir) return [];
  const plannedPaths = buildPlannedPathSet(affectedFiles ?? [], affectedRepositories ?? []);
  return [
    ...await detectConfigDuplicates(steps, repoDir, plannedPaths),
    ...await detectNameDuplicates(steps, repoDir, plannedPaths),
  ];
};
