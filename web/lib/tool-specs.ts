/**
 * What the tool explorer tells a person about each of the 12 RepoAtlas tools. Written for someone
 * who has never used an MCP server: plain words, one idea per sentence, an example for every
 * input, and a list of what comes back. Keep it in sync with the tools in src/modules; the
 * input names must match (tests/web-schemas.test.ts checks that).
 */

export interface Field {
  /** The tool's input name. */
  name: string;
  /** What a person sees above the box. */
  label: string;
  kind: 'text' | 'number' | 'select';
  /** Starting value. Empty means "leave blank". */
  default: string;
  required: boolean;
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
  /** Plain-language explanation of what to enter. Always shown under the box. */
  help: string;
  /** A value that works, offered as a one-click "Use example". */
  example?: string;
}

export interface Returned {
  name: string;
  meaning: string;
}

export interface ToolSpec {
  name: string;
  group: 'Foundation' | 'Understand' | 'Contribute' | 'Action';
  /** A friendly name shown next to the technical one. */
  title: string;
  /** What it does, in one or two plain sentences. */
  summary: string;
  /** When to reach for it. */
  whenToUse: string;
  fields: Field[];
  /** Shown when there is nothing to type. */
  noInputNote?: string;
  /** What you get back, field by field. */
  returns: Returned[];
  /** How to read the result and what to look at first. */
  readIt: string;
  /** Tools whose result includes the small import graph that the widget draws. */
  widget?: boolean;
}

export const GROUP_INFO: Record<ToolSpec['group'], { title: string; blurb: string }> = {
  Foundation: { title: '1. Start here', blurb: 'Load a repo. Every other tool needs this first.' },
  Understand: { title: '2. Understand the project', blurb: 'Learn what the project is and where to read first.' },
  Contribute: { title: '3. Find something to work on', blurb: 'Match yourself to an issue and see which files it touches.' },
  Action: { title: '4. Export', blurb: 'Turn what was learned into a document.' },
};

const ROLE_FIELD: Field = {
  name: 'role',
  label: 'Who is reading?',
  kind: 'select',
  default: 'new_dev',
  required: true,
  options: [
    { value: 'new_dev', label: 'New developer: I want to learn the whole project' },
    { value: 'reviewer', label: 'Reviewer: I review changes to it' },
    { value: 'tester', label: 'Tester: I test it' },
    { value: 'quick_look', label: 'Quick look: a five-minute skim' },
  ],
  help: 'The answer is tuned to your job. A new developer sees everything; a tester sees mainly the entry points and the tests.',
};

const PROFILE_FIELDS: Field[] = [
  {
    name: 'languages',
    label: 'Languages you know',
    kind: 'text',
    default: 'TypeScript',
    required: true,
    placeholder: 'TypeScript, Python',
    help: 'The programming languages you are comfortable with. Separate several with commas. Issues in files written in these languages rank higher.',
    example: 'TypeScript, Python',
  },
  {
    name: 'level',
    label: 'Your experience',
    kind: 'select',
    default: 'beginner',
    required: true,
    options: [
      { value: 'beginner', label: 'Beginner: under about a year of experience' },
      { value: 'intermediate', label: 'Intermediate: comfortable working on my own' },
      { value: 'advanced', label: 'Advanced: happy to change core code' },
    ],
    help: 'Beginners are shown small changes in few files; advanced developers are shown bigger ones.',
  },
  {
    name: 'areas',
    label: 'Areas you like (optional)',
    kind: 'text',
    default: '',
    required: false,
    placeholder: 'tests, docs, api',
    help: 'Parts of a project you enjoy, such as tests, docs, api, ui, database or cli. Leave empty if you have no preference.',
    example: 'tests, docs',
  },
];

const ISSUE_FIELD: Field = {
  name: 'issueNumber',
  label: 'Issue number (optional)',
  kind: 'number',
  default: '',
  required: false,
  placeholder: 'leave empty to use the best match',
  help: 'The number after the # on a GitHub issue, for example 1860. It must be an open issue from this repo. If you leave it empty, the explorer first finds the best issue for you (it runs find_candidate_issues for you) and uses that one.',
};

export const STAGE_OPTIONS = [
  { value: '1', label: '1. Orient: what the project is and how to run it' },
  { value: '2', label: '2. Layout: what each top-level folder is for' },
  { value: '3', label: '3. Entry points: where the code starts running' },
  { value: '4', label: '4. Core modules: the files most others depend on' },
  { value: '5', label: '5. Data and config: models, settings, outside services' },
  { value: '6', label: '6. Tests: which tests cover which code' },
  { value: '7', label: '7. Change patterns: what usually changes together' },
  { value: '8', label: '8. People: who looks after which part' },
] as const;

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'build_graph',
    group: 'Foundation',
    title: 'Load a repository',
    summary: 'Reads a GitHub repo and builds a saved map of it: its files, how they import each other, its history, its people and its open issues. This map is called a snapshot, and every other tool works on it.',
    whenToUse: 'Always first. Four repos load instantly. Any other public GitHub repo is built when you ask, which takes about 5 to 40 seconds the first time.',
    fields: [],
    noInputNote: 'Nothing to type here. It loads the repo chosen in the Repo box on the left. To use a different repo, choose "Another GitHub repo…" there and paste a link such as https://github.com/pallets/click.',
    returns: [
      { name: 'Status', meaning: '"ready" means the map exists. "unavailable" means it could not be built, and the message says why.' },
      { name: 'Snapshot id', meaning: 'The name of the saved map, like owner__repo@abc1234. The other tools use it automatically.' },
      { name: 'Source', meaning: 'Whether the map was prepared ahead of time or built just now from GitHub.' },
      { name: 'Tier', meaning: '1 means a file list, history and people only. 2 also includes how files import each other.' },
      { name: 'Stats', meaning: 'How many files, folders, import links, people and merged pull requests it found.' },
      { name: 'Limits and caveats', meaning: 'What is approximate or missing, and the date the map was made.' },
    ],
    readIt: 'Check "Status" first. If it says ready, read "Limits and caveats" so you know what to trust. Then move on to the next tool in the list.',
  },
  {
    name: 'project_overview',
    group: 'Understand',
    title: 'Get the project summary',
    summary: 'A one-page summary of the project: what it is, what it is built with, how to install and run it, and what each top-level folder is for.',
    whenToUse: 'Right after loading a repo, to get your bearings.',
    fields: [],
    noInputNote: 'Nothing to type. It uses the repo you loaded.',
    returns: [
      { name: 'Name, description, license, language', meaning: 'The basics, taken from the repo.' },
      { name: 'Run steps', meaning: 'Commands to install, build, run and test. "inferred" means the usual command for that tooling, not one read from a file.' },
      { name: 'Folders', meaning: 'Each top-level folder with the job it appears to do.' },
      { name: 'Entry points', meaning: 'Files where the program starts.' },
      { name: 'Evidence', meaning: 'Where each fact came from, so you can check it.' },
    ],
    readIt: 'Treat commands marked "inferred" as a good guess and confirm them in the README before relying on them.',
  },
  {
    name: 'find_entry_points',
    group: 'Understand',
    title: 'Find where the code starts',
    summary: 'Lists the files where the program begins running (a server start file, a command-line script, a main function) and explains why each was picked.',
    whenToUse: 'When you want to know which file to open first.',
    fields: [],
    noInputNote: 'Nothing to type. It uses the repo you loaded.',
    returns: [
      { name: 'Entry points', meaning: 'Each file, its kind (server, command, main and so on), the reasons it was picked and the command that starts it.' },
      { name: 'Likely public files', meaning: 'For libraries that have no program to start: the files other projects import.' },
      { name: 'First import chain', meaning: 'The first few files you reach by following imports from the entry point.' },
    ],
    readIt: 'A library may have no entry point, and that is normal. In that case read the "likely public files" instead.',
  },
  {
    name: 'key_files',
    group: 'Understand',
    title: 'Rank the most important files',
    summary: 'Scores every file and sorts them into three groups: Must read, Read next and Skip for now. Each file shows why it scored the way it did.',
    whenToUse: 'When you ask "which files should I read first?"',
    fields: [
      ROLE_FIELD,
      {
        name: 'limit',
        label: 'Files per group (optional)',
        kind: 'number',
        default: '',
        required: false,
        placeholder: 'default is 10',
        help: 'How many files to list in each group, from 1 to 50. Leave empty for the default.',
        example: '5',
      },
    ],
    returns: [
      { name: 'Must read / Read next / Skip for now', meaning: 'The top 10% of files, the next 25%, and the rest.' },
      { name: 'Score and components', meaning: 'The total, plus what raised it: being an entry point, being imported by many files, being config, being changed often, being mentioned in docs, having tests.' },
      { name: 'Reason', meaning: 'One plain sentence about why a file is on the list.' },
    ],
    readIt: 'Start with "Must read" and open the first file. The components show why it is there. The formula is fixed, so the same repo always gives the same list.',
  },
  {
    name: 'trace_flow',
    group: 'Understand',
    title: 'Follow the imports from a file',
    summary: 'Starting at one file, follows the "this file imports that file" links and lists the files in the order they are reached, like following a trail of breadcrumbs.',
    whenToUse: 'When you want to see what a file depends on, and what those files depend on.',
    fields: [
      {
        name: 'entry',
        label: 'Start file (optional)',
        kind: 'text',
        default: '',
        required: false,
        placeholder: 'leave empty to start at the main entry point',
        help: 'The path of the file to start from, as shown in the repo, such as src/index.ts. Leave it empty and the explorer starts from the repo\'s first entry point.',
        example: 'src/index.ts',
      },
      {
        name: 'depth',
        label: 'How many hops (optional)',
        kind: 'number',
        default: '',
        required: false,
        placeholder: 'default is 4',
        help: 'How many import steps to follow, from 1 to 6. More hops means a longer list.',
        example: '3',
      },
      {
        name: 'maxFiles',
        label: 'Most files to list (optional)',
        kind: 'number',
        default: '',
        required: false,
        placeholder: 'default is 20',
        help: 'A cap on the list length, from 1 to 40.',
        example: '15',
      },
    ],
    returns: [
      { name: 'Steps', meaning: 'The files in the order they are reached, each with how many hops from the start.' },
      { name: 'Edges used', meaning: 'How many import links were followed.' },
      { name: 'Caps', meaning: 'Whether the list was cut short by the hop or file limit.' },
    ],
    readIt: 'The first item is where you started. Items further down are things the earlier ones depend on. A file with hop 1 is imported directly by the start file.',
  },
  {
    name: 'explain_file',
    group: 'Understand',
    title: 'Explain one file',
    summary: 'Everything known about a single file: its job, what it exports, what it imports, which files import it, who looks after it, its tests and its recent changes. It also draws a small map of the files around it.',
    whenToUse: 'When you have opened a file and want to know where it fits.',
    fields: [
      {
        name: 'path',
        label: 'File path (optional)',
        kind: 'text',
        default: '',
        required: false,
        placeholder: 'leave empty to explain the main entry point',
        help: 'The path of the file inside the repo, such as src/index.ts. A unique file name (index.ts) also works. Leave it empty and the explorer picks the repo\'s first entry point. You can also click any file name in a result to explain it.',
        example: 'src/index.ts',
      },
    ],
    returns: [
      { name: 'Role', meaning: 'What kind of file it is, such as entry point, route, service or test.' },
      { name: 'Exports and imports', meaning: 'What it offers to other files and what it uses from them.' },
      { name: 'Imported by', meaning: 'The files that depend on it. Many of them means changes here are riskier.' },
      { name: 'Owners, tests, recent changes', meaning: 'Who changed it most, which tests cover it, and its latest commits and pull requests.' },
      { name: 'Graph', meaning: 'A picture of this file (highlighted) and its closest neighbours.' },
    ],
    readIt: 'Look at the graph first. Click a box to light up that file\'s connections, or press "Explain this file" to jump to it. The arrows go from the importing file to the imported file.',
    widget: true,
  },
  {
    name: 'tour_next',
    group: 'Understand',
    title: 'Take the guided tour, one stop at a time',
    summary: 'Gives one stop of an eight-stop tour for the role you pick: what to learn, the evidence from the repo, a question to check your understanding, and a small graph. Run it again with the next stop number to keep going.',
    whenToUse: 'To learn a project in a sensible order. Start at stop 1 and work upward.',
    fields: [
      ROLE_FIELD,
      {
        name: 'stage',
        label: 'Which stop?',
        kind: 'select',
        default: '1',
        required: true,
        options: STAGE_OPTIONS,
        help: 'Stops go from 1 (the big picture) to 8 (people). Some roles skip stops: a tester sees 1, 3 and 6, and a result tells you when a stop was skipped.',
      },
    ],
    returns: [
      { name: 'Name and "Learn"', meaning: 'What this stop is about and the one thing to take away.' },
      { name: 'Content', meaning: 'The facts for this stop, with the evidence behind them.' },
      { name: 'Check question', meaning: 'A short question and its answer. Try to answer it before reading the answer.' },
      { name: 'Next stage', meaning: 'Which stop to run next.' },
      { name: 'Graph', meaning: 'A small map of the files this stop is about.' },
    ],
    readIt: 'Read "Learn", then try the check question in your head, then compare with the answer. Run the next stop when you are ready. The last stop points you to the issue tools.',
    widget: true,
  },
  {
    name: 'profile_contributor',
    group: 'Contribute',
    title: 'Describe yourself',
    summary: 'Turns what you tell it (languages, experience, areas you like) into a small profile that the issue tools use to match you with suitable work. Nothing is looked up about you.',
    whenToUse: 'Before looking for issues. The explorer does this step for you when you run the next tools, so use it on its own only to see what a profile looks like.',
    fields: PROFILE_FIELDS,
    returns: [
      { name: 'Profile', meaning: 'Your languages (as short ids such as ts or py), your level and your areas.' },
      { name: 'What was read', meaning: 'A plain statement of exactly where the information came from. Here it is only what you typed.' },
    ],
    readIt: 'Check that your languages were recognised. The profile is passed to find_candidate_issues and score_first_change.',
  },
  {
    name: 'find_candidate_issues',
    group: 'Contribute',
    title: 'Find issues you could finish',
    summary: 'Goes through the repo\'s open issues and keeps only ones that are still open, recent, clear and probably unclaimed, then ranks them for your profile. It shows why each issue passed.',
    whenToUse: 'When you want something to work on.',
    fields: [
      ...PROFILE_FIELDS,
      {
        name: 'limit',
        label: 'How many issues (optional)',
        kind: 'number',
        default: '10',
        required: false,
        placeholder: 'default is 10',
        help: 'How many issues to return, from 1 to 25.',
        example: '5',
      },
    ],
    returns: [
      { name: 'Considered and excluded', meaning: 'How many issues were looked at and how many were dropped (too old, blocked, already claimed, unclear).' },
      { name: 'Candidates', meaning: 'The issues that passed, best first, each with its number, title, GitHub link and labels.' },
      { name: 'Why it passed', meaning: 'The checks the issue passed, in plain words.' },
      { name: 'Claim evidence', meaning: 'What suggests nobody is working on it (no assignee, no linked pull request, no "I\'ll take this" comment).' },
    ],
    readIt: '"Likely unclaimed" is evidence, not a promise, so open the issue on GitHub before you start. An empty list can simply mean the repo has no open issues. Repos built on demand without a server GitHub token have thinner issue data.',
  },
  {
    name: 'localize_issue',
    group: 'Contribute',
    title: 'Find the files an issue would change',
    summary: 'Given an open issue, ranks the five files most likely to need changing. For each it shows the evidence: matching words, similar past fixes, neighbouring files and recent changes. It also gives an owner and a reading order.',
    whenToUse: 'After you have picked an issue and want to know where to look in the code.',
    fields: [ISSUE_FIELD],
    returns: [
      { name: 'Files', meaning: 'Up to five files, each with a score from 0 to 1.' },
      { name: 'Score components', meaning: 'Four parts that make up the score: textMatch (words in the issue match the file), historySimilarity (similar past fixes touched it), graphProximity (it sits next to a likely file) and recency (it changed recently).' },
      { name: 'Evidence', meaning: 'Plain sentences backing each file up.' },
      { name: 'Owner and tests', meaning: 'Who changed the file most and which tests cover it.' },
      { name: 'Reading order and confidence', meaning: 'The order to read the files (dependencies first), and how far to trust the result.' },
    ],
    readIt: 'Check "Confidence" first. Then read the files in "Reading order". A high score with several evidence lines is a strong match; a low score means the guess is weak.',
  },
  {
    name: 'score_first_change',
    group: 'Contribute',
    title: 'Score how good a first task it is',
    summary: 'Rates an issue as a first contribution for you, from 0 to 1, by multiplying six factors: language fit, how central the files are, whether tests exist, how fresh the issue is, how clear it is and how big the change is. Every factor is shown.',
    whenToUse: 'To compare issues, or to check whether one is a sensible first task.',
    fields: [ISSUE_FIELD, ...PROFILE_FIELDS],
    returns: [
      { name: 'Score', meaning: 'The overall fit from 0 to 1. Higher is a better first task.' },
      { name: 'Factors', meaning: 'Each of the six parts with its value and a plain explanation. A weak factor lowers the score but never makes it zero.' },
      { name: 'Effort', meaning: 'A rough estimate of the work. It is a guess, not a promise.' },
      { name: 'Files, reading order, watch-outs', meaning: 'Which files it touches, in what order to read them, and warnings such as "touches code with no tests".' },
    ],
    readIt: 'Look for the lowest factor, because that is the main reason the score is not higher. Read the watch-outs before you start.',
  },
  {
    name: 'export_guide',
    group: 'Action',
    title: 'Export an ARCHITECTURE.md draft (two steps)',
    summary: 'Writes a draft ARCHITECTURE.md describing the project. It works in two steps on purpose: first a preview that you can read in full, then, once you confirm, the final text with Download .md, Download PDF and Copy buttons. It only returns text and never changes anything in the repo.',
    whenToUse: 'When you want a written guide to hand to a teammate.',
    fields: [],
    noInputNote: 'Nothing to type. Press "Step 1: Preview the guide", read the draft, then press "Step 2: Get the full draft" to download it as .md or PDF. The page handles the confirmation code for you.',
    returns: [
      { name: 'Step 1: preview', meaning: 'The title, the outline and the whole draft, so you can review everything first. Nothing is written anywhere.' },
      { name: 'Step 2: final draft', meaning: 'The same ARCHITECTURE.md, with Download .md, Download PDF and Copy buttons.' },
    ],
    readIt: 'Press "Test the safety check" once to see the server refuse a request that skips the preview. Text taken from the repo is flattened in the draft, so links and formatting from the repo cannot sneak in.',
  },
];

export const GROUPS: ToolSpec['group'][] = ['Foundation', 'Understand', 'Contribute', 'Action'];

/** Words a newcomer will meet, in plain language. */
export const GLOSSARY: { term: string; meaning: string }[] = [
  { term: 'Snapshot', meaning: 'A saved map of one repo at one moment: files, imports, history, people and issues. Built by "Load a repository".' },
  { term: 'Tier', meaning: 'How detailed the map is. Tier 1: files, history and people. Tier 2: also how files import each other (JavaScript, TypeScript and Python).' },
  { term: 'Entry point', meaning: 'A file where the program starts running, such as a server or a command-line script.' },
  { term: 'Import', meaning: 'When one file uses code from another. "A imports B" means A depends on B.' },
  { term: 'Imported by (fan-in)', meaning: 'How many files depend on a file. A high number means many things would break if it changed.' },
  { term: 'Role', meaning: 'Who the answer is for: new developer, reviewer, tester or quick look.' },
  { term: 'Stage', meaning: 'One stop of the eight-stop guided tour.' },
  { term: 'Profile', meaning: 'Your languages, experience and interests, used to match you with issues.' },
  { term: 'Confirmation code', meaning: 'A short-lived code the server gives with the export preview. Sending it back is how the server knows you saw the preview first. The page does this for you when you press Step 2.' },
  { term: 'Widget', meaning: 'The small interactive picture (the import graph) that some tools draw.' },
];
