import type { AssessableStep } from './step-spec-fidelity.service';

export type EvidenceSection = {
  path: string;
  kind: 'tracked' | 'untracked';
  content: string;
  mentioned: boolean;
  binary?: boolean;
};

export type EvidenceBudgetReport = {
  totalMeasured: number;
  budget: number;
  truncated: { path: string; shownChars: number; fullChars: number }[];
  omitted: string[];
};

export type PhasedGroup = { steps: AssessableStep[]; sections: EvidenceSection[] };

export const EVIDENCE_FLOOR_CHARS = 60_000;
export const EVIDENCE_CEILING_CHARS = 240_000;
const BASELINE_FLOOR_CHARS = 2_000;
const TINY_BUDGET_PER_SECTION_CHARS = 500;
const HEAD_SHARE = 0.6;
const REQUIRES_MISSING_SUFFIX = ' (requires missing field)';
const EVIDENCE_GAP_CLAUSE
  = ', and for steps whose only doubt lies beyond a disclosed evidence gap (name the path in `missing`)';

export const unverifiableRule = (subject: string, extraClause = ''): string =>
  `- unverifiable: ONLY for temporal, process, or investigation claims that ${subject} cannot in principle prove or disprove${extraClause}${REQUIRES_MISSING_SUFFIX}`;

export const buildStepResponseShapeLines = (indices: number[]): string[] => {
  const [first, second] = indices;
  const entries = [
    `{"index":${first},"status":"done"}`,
    ...(second === undefined ? [] : [`{"index":${second},"status":"partially-done","missing":"…"}`]),
  ];
  return [
    'Produce exactly one entry per [Plan step N] tag above — no more, no fewer — in this shape:',
    `{"statuses":[${entries.join(',')}]}`,
    'Use the exact N from each [Plan step N] tag — never renumber from 0.',
  ];
};

export const buildAssessorStatusRules = (indices: number[]): string[] => [
  '## Status rules',
  '- done: fully implemented in the evidence',
  '- partially-done: started but incomplete (requires missing field)',
  '- not-done: not implemented, including any step whose named file shows no change in the changed-files list (requires missing field)',
  '- not-applicable: step requires no code change or cannot be proven by a diff (e.g. run-the-tests steps, confirm-existing-behavior steps) — use instead of not-done for such steps',
  unverifiableRule('evidence'),
  '- Paths under another repository prefix are outside this assessment; judge only the current repository portion.',
  '',
  'Index each step ONLY by its [Plan step N] tag. A step\'s own text may contain other numbers '
  + '(e.g. an internal "Step N (RED)/(GREEN)" label) — those are part of that step\'s content, not separate steps to assess.',
  ...buildStepResponseShapeLines(indices),
  'Do not assume changes you cannot see.',
];

export const hasEvidenceGaps = (report: EvidenceBudgetReport): boolean =>
  report.truncated.length > 0 || report.omitted.length > 0;

export const gapAwareStatusRules = (report: EvidenceBudgetReport, indices: number[]): string[] => {
  const rules = buildAssessorStatusRules(indices);
  if (!hasEvidenceGaps(report)) return rules;
  const plainRule = unverifiableRule('evidence');
  return rules.map(line => (line === plainRule ? unverifiableRule('evidence', EVIDENCE_GAP_CLAUSE) : line));
};

export const computeEvidenceBudget = (
  args: { measuredTotal: number; nameStatusLength: number; floor: number; ceiling: number },
): number => {
  const demand = args.measuredTotal + args.nameStatusLength;
  const clamped = Math.min(args.ceiling, Math.max(args.floor, demand));
  return Math.max(0, clamped - args.nameStatusLength);
};

const buildGapMarker = (omittedChars: number): string => `\n[... evidence gap: ${omittedChars} chars omitted ...]\n`;

export const sliceHeadTail = (content: string, limit: number): string => {
  if (content.length <= limit) return content;
  const available = limit - buildGapMarker(content.length).length;
  if (available <= 0) return '';
  const headChars = Math.ceil(available * HEAD_SHARE);
  const tailChars = available - headChars;
  const tail = tailChars > 0 ? content.slice(-tailChars) : '';
  return `${content.slice(0, headChars)}${buildGapMarker(content.length - available)}${tail}`;
};

const renderSection = (section: EvidenceSection, content: string): string => {
  if (section.binary || section.kind === 'tracked') return `### ${section.path}\n${content}`;
  return `### ${section.path}\n\`\`\`\n${content}\n\`\`\``;
};

const sumContentChars = (sections: EvidenceSection[]): number =>
  sections.reduce((sum, section) => sum + section.content.length, 0);

const orderByPriority = (sections: EvidenceSection[]): EvidenceSection[] =>
  [...sections.filter(s => s.mentioned), ...sections.filter(s => !s.mentioned)];

const allocateGreedyWholeLimits = (ordered: EvidenceSection[], budget: number): Map<string, number> => {
  const limits = new Map<string, number>();
  let remaining = budget;
  for (const section of ordered) {
    const fits = section.content.length <= remaining;
    limits.set(section.path, fits ? section.content.length : 0);
    remaining -= fits ? section.content.length : 0;
  }
  return limits;
};

const redistributeSurplus = (ordered: EvidenceSection[], limits: Map<string, number>, surplus: number): void => {
  let remaining = surplus;
  const truncated = ordered
    .filter(s => (limits.get(s.path) ?? 0) < s.content.length)
    .sort((a, b) => Number(b.mentioned) - Number(a.mentioned) || b.content.length - a.content.length);
  for (const section of truncated) {
    if (remaining <= 0) return;
    const current = limits.get(section.path) ?? 0;
    const extra = Math.min(section.content.length - current, remaining);
    limits.set(section.path, current + extra);
    remaining -= extra;
  }
};

const allocateBaselineLimits = (ordered: EvidenceSection[], budget: number): Map<string, number> => {
  const baseline = Math.max(BASELINE_FLOOR_CHARS, Math.floor(budget / ordered.length));
  const limits = new Map<string, number>();
  let remaining = budget;
  for (const section of ordered) {
    const grant = Math.min(section.content.length, baseline, remaining);
    limits.set(section.path, grant);
    remaining -= grant;
  }
  redistributeSurplus(ordered, limits, remaining);
  return limits;
};

const allocateLimits = (ordered: EvidenceSection[], totalMeasured: number, budget: number): Map<string, number> => {
  if (totalMeasured <= budget) return new Map(ordered.map(s => [s.path, s.content.length]));
  if (budget / ordered.length < TINY_BUDGET_PER_SECTION_CHARS) return allocateGreedyWholeLimits(ordered, budget);
  return allocateBaselineLimits(ordered, budget);
};

const allocateSection = (
  section: EvidenceSection, limit: number, rendered: Map<string, string>, report: EvidenceBudgetReport,
): void => {
  const shown = sliceHeadTail(section.content, limit);
  if (!shown && section.content) {
    report.omitted.push(section.path);
    return;
  }
  rendered.set(section.path, renderSection(section, shown));
  if (shown.length === section.content.length) return;
  report.truncated.push({ path: section.path, shownChars: shown.length, fullChars: section.content.length });
};

export const allocateEvidence = (
  sections: EvidenceSection[], budget: number,
): { rendered: Map<string, string>; report: EvidenceBudgetReport } => {
  const textSections = sections.filter(s => !s.binary);
  const rendered = new Map<string, string>(
    sections.filter(s => s.binary).map((s): [string, string] => [s.path, renderSection(s, s.content)]),
  );
  const totalMeasured = sumContentChars(textSections);
  const report: EvidenceBudgetReport = { totalMeasured, budget, truncated: [], omitted: [] };
  const ordered = orderByPriority(textSections);
  const limits = ordered.length ? allocateLimits(ordered, totalMeasured, budget) : new Map<string, number>();
  for (const section of ordered) allocateSection(section, limits.get(section.path) ?? 0, rendered, report);
  return { rendered, report };
};

export const buildEvidenceCompletenessSection = (report: EvidenceBudgetReport): string => {
  if (!hasEvidenceGaps(report)) return '';
  const truncatedLines = report.truncated.map(t => `- ${t.path} (${t.shownChars} of ${t.fullChars} chars shown)`);
  const omittedLines = report.omitted.map(path => `- ${path} (hunks omitted entirely)`);
  return [
    '',
    '## Evidence completeness',
    'The evidence above is NOT complete. The changed-files list remains authoritative.',
    ...(truncatedLines.length ? ['Truncated (middle removed, head and tail kept):', ...truncatedLines] : []),
    ...(omittedLines.length ? ['Omitted for size:', ...omittedLines] : []),
    '',
  ].join('\n');
};

const mentionedSections = (step: AssessableStep, sections: EvidenceSection[]): EvidenceSection[] =>
  sections.filter(section => step.text.includes(section.path));

type MutableGroup = { steps: AssessableStep[]; sections: Map<string, EvidenceSection>; total: number };

const createGroup = (): MutableGroup => ({ steps: [], sections: new Map(), total: 0 });

const spareOf = (group: MutableGroup, ceiling: number): number => ceiling - group.total;

const addSections = (group: MutableGroup, sections: EvidenceSection[]): void => {
  for (const section of sections.filter(s => !group.sections.has(s.path))) {
    group.sections.set(section.path, section);
    group.total += section.content.length;
  }
};

const newCharsFor = (group: MutableGroup, sections: EvidenceSection[]): number =>
  sumContentChars(sections.filter(s => !group.sections.has(s.path)));

const findMostSpareGroup = (groups: MutableGroup[], ceiling: number): MutableGroup =>
  groups.reduce((best, group) => (spareOf(group, ceiling) > spareOf(best, ceiling) ? group : best), groups[0]);

const pickGroupForMentions = (groups: MutableGroup[], mentions: EvidenceSection[], ceiling: number): MutableGroup => {
  const current = groups.at(-1);
  if (current && current.total + newCharsFor(current, mentions) <= ceiling) return current;
  const created = createGroup();
  groups.push(created);
  return created;
};

const assignMentioningSteps = (
  steps: AssessableStep[], sections: EvidenceSection[], ceiling: number,
): { groups: MutableGroup[]; noMentionSteps: AssessableStep[] } => {
  const groups: MutableGroup[] = [];
  const noMentionSteps = steps.filter(step => !mentionedSections(step, sections).length);
  for (const step of steps.filter(s => mentionedSections(s, sections).length)) {
    const mentions = mentionedSections(step, sections);
    const target = pickGroupForMentions(groups, mentions, ceiling);
    target.steps.push(step);
    addSections(target, mentions);
  }
  return { groups: groups.length ? groups : [createGroup()], noMentionSteps };
};

const placeUnmentionedSections = (
  groups: MutableGroup[], sections: EvidenceSection[], steps: AssessableStep[], ceiling: number,
): void => {
  const mentionedPaths = new Set(steps.flatMap(step => mentionedSections(step, sections).map(s => s.path)));
  const leftovers = sections.filter(s => !mentionedPaths.has(s.path));
  const prioritized = [...leftovers.filter(s => s.mentioned), ...leftovers.filter(s => !s.mentioned)];
  for (const section of prioritized) {
    const target = findMostSpareGroup(groups, ceiling);
    if (spareOf(target, ceiling) >= section.content.length) addSections(target, [section]);
  }
};

export const partitionStepsForPhasedAssessment = (
  steps: AssessableStep[], sections: EvidenceSection[], ceiling: number,
): PhasedGroup[] => {
  const ordered = [...steps].sort((a, b) => a.index - b.index);
  const { groups, noMentionSteps } = assignMentioningSteps(ordered, sections, ceiling);
  for (const step of noMentionSteps) findMostSpareGroup(groups, ceiling).steps.push(step);
  placeUnmentionedSections(groups, sections, ordered, ceiling);
  return groups.map(group => ({
    steps: group.steps.toSorted((a, b) => a.index - b.index),
    sections: [...group.sections.values()],
  }));
};
