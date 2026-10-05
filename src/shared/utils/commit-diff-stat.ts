export interface DiffFileStat {
  file: string;
  changedLines: number;
}

const FILE_HEADER_PATTERN = /^diff --git a\/(.+?) b\/(.+)$/;
const DOCS_ONLY_FILE_PATTERN = /(^|\/)README(\..+)?$|(^|\/)docs\/|\.md$/i;
const CONVENTIONAL_TYPE_PATTERN = /^(?:[A-Z][A-Z0-9]*-\d+:\s*)?([a-z]+)(?:\([^)]+\))?:/;
const docsOnlyCommitTypes = new Set(['docs', 'style', 'chore']);

const splitDiffIntoFileSections = (diff: string): Map<string, string> => {
  const sections = new Map<string, string>();
  for (const chunk of diff.split(/(?=^diff --git )/m)) {
    const headerMatch = FILE_HEADER_PATTERN.exec(chunk.split('\n')[0] ?? '');
    if (headerMatch) sections.set(headerMatch[2], chunk.replace(/\n$/, ''));
  }
  return sections;
};

export const parseDiffFileStats = (diff: string): DiffFileStat[] => {
  const sections = splitDiffIntoFileSections(diff);
  return Array.from(sections.entries()).map(([file, section]) => {
    const changedLines = section
      .split('\n')
      .filter(line => /^[+-]/.test(line) && !line.startsWith('+++') && !line.startsWith('---'))
      .length;
    return { file, changedLines };
  });
};

export const formatDiffStatSummary = (stats: DiffFileStat[]): string => {
  const ordered = [...stats].sort((a, b) => b.changedLines - a.changedLines);
  const lines = ordered.map(s => `  ${s.file} (${s.changedLines} lines changed)`);
  return `Files changed (${stats.length}):\n${lines.join('\n')}`;
};

const MIN_SNIPPET_CHARS = 200;
const MEANINGFUL_SNIPPET_FLOOR = 40;
const TRUNCATION_MARKER = '\n... (truncated)';

interface IncludedFile {
  file: string;
  content: string;
  isTruncated: boolean;
  fullLength: number;
}

const partitionWholeSectionsByBudget = (ordered: DiffFileStat[], sections: Map<string, string>, maxChars: number) => {
  const included: IncludedFile[] = [];
  const omitted: string[] = [];
  let remaining = maxChars;
  for (const { file } of ordered) {
    const section = sections.get(file) ?? '';
    if (section.length <= remaining) {
      included.push({ file, content: section, isTruncated: false, fullLength: section.length });
      remaining -= section.length;
    } else omitted.push(file);
  }
  return { included, omitted };
};

const computeFileBaselines = (ordered: DiffFileStat[], sections: Map<string, string>, perFileBaseline: number) => {
  const baselines = new Map<string, number>();
  let totalBaseline = 0;
  for (const { file } of ordered) {
    const allocation = Math.min((sections.get(file) ?? '').length, perFileBaseline);
    baselines.set(file, allocation);
    totalBaseline += allocation;
  }
  return { baselines, totalBaseline };
};

const allocateBaselineSnippets = (
  ordered: DiffFileStat[], sections: Map<string, string>, baselines: Map<string, number>, initialRemaining: number
) => {
  const included: IncludedFile[] = [];
  let remaining = initialRemaining;
  for (const { file } of ordered) {
    const section = sections.get(file) ?? '';
    const baseline = baselines.get(file) ?? 0;
    const isTruncated = section.length > baseline;
    const content = isTruncated ? section.slice(0, baseline) + TRUNCATION_MARKER : section;
    included.push({ file, content, isTruncated, fullLength: section.length });
    if (isTruncated) remaining -= TRUNCATION_MARKER.length;
  }
  return { included, remaining };
};

const expandTruncatedFile = (f: IncludedFile, sec: string, budget: number): number => {
  const baseline = f.content.length - TRUNCATION_MARKER.length;
  const additionalCost = sec.length - baseline - TRUNCATION_MARKER.length;
  if (additionalCost <= budget) {
    f.content = sec;
    f.isTruncated = false;
    return budget - additionalCost;
  }
  f.content = sec.slice(0, baseline + budget) + TRUNCATION_MARKER;
  return 0;
};

const expandTruncatedFiles = (included: IncludedFile[], sections: Map<string, string>, initialBudget: number): void => {
  let budget = initialBudget;
  for (const f of included.filter(x => x.isTruncated).sort((a, b) => b.fullLength - a.fullLength)) {
    if (budget <= 0) break;
    budget = expandTruncatedFile(f, sections.get(f.file) ?? '', budget);
  }
};

const partitionSectionsByBudget = (
  ordered: DiffFileStat[], sections: Map<string, string>, maxChars: number
): { included: IncludedFile[]; omitted: string[] } => {
  const perFileBaseline = Math.min(MIN_SNIPPET_CHARS, Math.floor(maxChars / Math.max(1, ordered.length)));
  if (perFileBaseline < MEANINGFUL_SNIPPET_FLOOR) return partitionWholeSectionsByBudget(ordered, sections, maxChars);
  const { baselines, totalBaseline } = computeFileBaselines(ordered, sections, perFileBaseline);
  const { included, remaining } = allocateBaselineSnippets(ordered, sections, baselines, maxChars - totalBaseline);
  expandTruncatedFiles(included, sections, remaining);
  const omitted = Array.from(sections.keys()).filter(f => !included.find(inc => inc.file === f));
  return { included, omitted };
};

export const buildPrioritizedDiffExcerpt = (diff: string, stats: DiffFileStat[], maxChars: number): string => {
  const sections = splitDiffIntoFileSections(diff);
  if (sections.size === 0) return diff.slice(0, maxChars);
  const { included, omitted } = partitionSectionsByBudget(
    [...stats].sort((a, b) => b.changedLines - a.changedLines), sections, maxChars);
  const includedByFile = new Map(included.map(f => [f.file, f.content]));
  const result = Array.from(sections.keys()).reduce((r, f) => {
    const c = includedByFile.get(f);
    return c ? [...r, c] : r;
  }, [] as string[]);
  const note = omitted.length > 0 ? `\n\n(diff omitted for ${omitted.length} file(s) to stay within length limits: ${omitted.join(', ')})` : '';
  return `${result.join('\n')}${note}`;
};

export const isDocsOnlyChangeset = (stats: DiffFileStat[]): boolean =>
  stats.length > 0 && stats.every(s => DOCS_ONLY_FILE_PATTERN.test(s.file));

export const extractConventionalType = (message: string): string | null =>
  CONVENTIONAL_TYPE_PATTERN.exec(message.trim())?.[1]?.toLowerCase() ?? null;

export const declaresDocsOnlyType = (message: string): boolean => {
  const type = extractConventionalType(message);
  return type !== null && docsOnlyCommitTypes.has(type);
};
