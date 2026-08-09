import chalk from 'chalk';

export type TraceProvenance = 'evidence-based' | 'best-effort' | 'unavailable';

export type SectionLabel = 'call stack' | 'state transition';

export const PROVENANCE_LABELS: Record<TraceProvenance, string> = {
  'evidence-based': 'Provenance: evidence-based (code-path trace backed by the execution backend)',
  'best-effort': 'Provenance: best-effort (code-path trace inferred from the diff and AI output)',
  unavailable: 'Provenance: unavailable (no concrete code-path trace could be inferred from the diff)',
};

export const PROVENANCE_COLORS: Record<TraceProvenance, typeof chalk.green> = {
  'evidence-based': chalk.green,
  'best-effort': chalk.yellow,
  unavailable: chalk.gray,
};

export const TRACE_DETAIL_LINES: Record<'evidence-based' | 'unavailable', (s: SectionLabel) => string> = {
  'evidence-based': s => 'Evidence: the ' + s + ' section is grounded in a code-path trace from the changed code.',
  unavailable: s => 'Trace unavailable: no concrete code-path trace could be inferred for the ' + s + ' section.',
};

export const BEST_EFFORT_TEXT: Record<SectionLabel, string> = {
  'call stack': 'Best effort: call stack is inferred from the changed code and AI output.',
  'state transition': 'Best effort: state transitions are inferred from the changed code and AI output.',
};

export const HINDRANCE_TEXT: Record<SectionLabel, string> = {
  'call stack': 'Hindrance: there is no runtime execution trace backend in this path.',
  'state transition': 'Hindrance: the review pipeline does not emit a machine-verified state trace.',
};
