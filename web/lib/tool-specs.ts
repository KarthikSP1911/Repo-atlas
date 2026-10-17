/** What the tool explorer shows for each of the 12 RepoAtlas tools: its inputs and a one-line summary. */

export interface Field {
  name: string;
  label: string;
  kind: 'text' | 'number' | 'select';
  default: string;
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
  help?: string;
}

export interface ToolSpec {
  name: string;
  group: 'Foundation' | 'Understand' | 'Contribute' | 'Action';
  summary: string;
  fields: Field[];
  /** Tools whose result includes the small import subgraph that the widget draws. */
  widget?: boolean;
}

const ROLE_OPTIONS = [
  { value: 'new_dev', label: 'New developer' },
  { value: 'reviewer', label: 'Reviewer' },
  { value: 'tester', label: 'Tester' },
  { value: 'quick_look', label: 'Quick look' },
] as const;

const PROFILE_FIELDS: Field[] = [
  { name: 'languages', label: 'Languages you know', kind: 'text', default: 'TypeScript', placeholder: 'TypeScript, Python', help: 'Comma separated.' },
  {
    name: 'level',
    label: 'Level',
    kind: 'select',
    default: 'beginner',
    options: [
      { value: 'beginner', label: 'Beginner' },
      { value: 'intermediate', label: 'Intermediate' },
      { value: 'advanced', label: 'Advanced' },
    ],
  },
  { name: 'areas', label: 'Familiar areas (optional)', kind: 'text', default: '', placeholder: 'api, tests, docs', help: 'Comma separated.' },
];

const ISSUE_FIELD: Field = {
  name: 'issueNumber',
  label: 'Issue number',
  kind: 'number',
  default: '',
  placeholder: 'leave empty to use the best candidate',
  help: 'An open issue from the snapshot. If empty, the explorer asks find_candidate_issues for the top one first.',
};

export const TOOL_SPECS: ToolSpec[] = [
  { name: 'build_graph', group: 'Foundation', summary: 'Resolve a repo to a precomputed snapshot: commit, tier, commit window, as-of time and stats. Every other tool takes the snapshot id it returns.', fields: [] },
  { name: 'project_overview', group: 'Understand', summary: 'Purpose, stack, run steps (marked when inferred), folder roles and entry points.', fields: [] },
  { name: 'find_entry_points', group: 'Understand', summary: 'Where execution starts, with the reason, the command and the first import chain.', fields: [] },
  {
    name: 'key_files',
    group: 'Understand',
    summary: 'The files to read first, in Must read, Read next and Skip tiers, with every score component.',
    fields: [
      { name: 'role', label: 'Role', kind: 'select', default: 'new_dev', options: ROLE_OPTIONS },
      { name: 'limit', label: 'Max files per tier', kind: 'number', default: '', placeholder: '10', help: '1 to 50. Empty uses the default.' },
    ],
  },
  {
    name: 'trace_flow',
    group: 'Understand',
    summary: 'The import chain from a file, in order, with the caps stated.',
    fields: [
      { name: 'entry', label: 'Start file', kind: 'text', default: '', placeholder: 'leave empty to use the first entry point', help: 'A path from find_entry_points. If empty, the explorer fetches the first entry point.' },
      { name: 'depth', label: 'Import hops', kind: 'number', default: '', placeholder: 'default', help: 'Empty uses the default.' },
      { name: 'maxFiles', label: 'Max files', kind: 'number', default: '', placeholder: 'default', help: 'Empty uses the default.' },
    ],
  },
  {
    name: 'explain_file',
    group: 'Understand',
    summary: 'Role, exports, imports, owners, tests, recent commits and PRs for one file, and the widget graph around it.',
    widget: true,
    fields: [{ name: 'path', label: 'File path', kind: 'text', default: '', placeholder: 'leave empty to use the first entry point', help: 'A unique file name or path suffix also works.' }],
  },
  {
    name: 'tour_next',
    group: 'Understand',
    summary: 'One stage of the guided tour for a role, a check question, the next stage and the widget graph.',
    widget: true,
    fields: [
      { name: 'role', label: 'Role', kind: 'select', default: 'new_dev', options: ROLE_OPTIONS },
      { name: 'stage', label: 'Stage (1 to 8)', kind: 'number', default: '4' },
    ],
  },
  { name: 'profile_contributor', group: 'Contribute', summary: 'Turn what you tell it into a contributor profile: languages, level, familiar areas.', fields: PROFILE_FIELDS },
  {
    name: 'find_candidate_issues',
    group: 'Contribute',
    summary: 'Open, recent, clear and likely unclaimed issues for a profile, with the evidence for each. The explorer builds the profile with profile_contributor first.',
    fields: [...PROFILE_FIELDS, { name: 'limit', label: 'How many', kind: 'number', default: '10', help: '1 to 25.' }],
  },
  { name: 'localize_issue', group: 'Contribute', summary: 'The top 5 files an issue would change, with evidence, owner, reading order and confidence.', fields: [ISSUE_FIELD] },
  { name: 'score_first_change', group: 'Contribute', summary: 'How good a first change an issue is for you, with every factor shown, an effort estimate and watch-outs.', fields: [ISSUE_FIELD, ...PROFILE_FIELDS] },
  {
    name: 'export_guide',
    group: 'Action',
    summary: 'Two steps on purpose. Without a token you get a preview and a confirm token; with the token you get the ARCHITECTURE.md draft. It only returns text and never writes to a repo.',
    fields: [{ name: 'confirmToken', label: 'Confirm token', kind: 'text', default: '', placeholder: 'empty for the preview', help: 'Paste the token from the preview, or press the confirm button under the preview.' }],
  },
];

export const GROUPS: ToolSpec['group'][] = ['Foundation', 'Understand', 'Contribute', 'Action'];
