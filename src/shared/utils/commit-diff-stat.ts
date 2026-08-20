export interface DiffFileStat {
  file: string;
  changedLines: number;
}

interface DiffSectionPartition {
  included: string[];
  omitted: string[];
}

const FILE_HEADER_PATTERN = /^diff --git a\/(.+?) b\/(.+)$/;
const DOCS_ONLY_FILE_PATTERN = /(^|\/)README(\..+)?$|(^|\/)docs\/|\.md$/i;
const CONVENTIONAL_TYPE_PATTERN = /^(?:[A-Z][A-Z0-9]*-\d+:\s*)?([a-z]+)(?:\([^)]+\))?:/;
const DOCS_ONLY_COMMIT_TYPES = new Set(['docs', 'style', 'chore']);

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

const accumulateSection = (
  partition: DiffSectionPartition, file: string, section: string, remaining: number
): number => {
  if (section.length <= remaining) {
    partition.included.push(section);
    return remaining - section.length;
  }
  partition.omitted.push(file);
  return remaining;
};

const partitionSectionsByBudget = (
  ordered: DiffFileStat[], sections: Map<string, string>, maxChars: number
): DiffSectionPartition => {
  const partition: DiffSectionPartition = { included: [], omitted: [] };
  let remaining = maxChars;
  for (const stat of ordered) {
    remaining = accumulateSection(partition, stat.file, sections.get(stat.file) ?? '', remaining);
  }
  return partition;
};

export const buildPrioritizedDiffExcerpt = (diff: string, stats: DiffFileStat[], maxChars: number): string => {
  const sections = splitDiffIntoFileSections(diff);
  if (sections.size === 0) return diff.slice(0, maxChars);

  const ordered = [...stats].sort((a, b) => b.changedLines - a.changedLines);
  const { included, omitted } = partitionSectionsByBudget(ordered, sections, maxChars);
  const omittedNote = omitted.length > 0
    ? `\n\n(diff omitted for ${omitted.length} file(s) to stay within length limits: ${omitted.join(', ')})`
    : '';
  return `${included.join('\n')}${omittedNote}`;
};

export const isDocsOnlyChangeset = (stats: DiffFileStat[]): boolean =>
  stats.length > 0 && stats.every(s => DOCS_ONLY_FILE_PATTERN.test(s.file));

export const extractConventionalType = (message: string): string | null =>
  CONVENTIONAL_TYPE_PATTERN.exec(message.trim())?.[1]?.toLowerCase() ?? null;

export const declaresDocsOnlyType = (message: string): boolean => {
  const type = extractConventionalType(message);
  return type !== null && DOCS_ONLY_COMMIT_TYPES.has(type);
};
