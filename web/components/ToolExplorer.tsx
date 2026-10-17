'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { buildGraphResponse, candidatesResponse, entryPointsResponse, exportPreviewResponse, parseResponse, profileResponse, repoSchema, toolArgs, validateForm, type ToolArgExtra } from '../lib/schemas';
import { GROUPS, GROUP_INFO, TOOL_SPECS, type Field, type ToolSpec } from '../lib/tool-specs';
import { GenericValue } from './GenericValue';
import { GraphPanel } from './GraphPanel';
import { RepoPicker } from './RepoPicker';
import { Select } from './Select';
import { CUSTOM_REPO, MISSING_SECRET_HINT, OLD_BUILD_HINT, REPOS, asRec, looksLikeMissingSecret, looksLikeOldBuild, recList, repoArgOf, str } from './demo-util';
import { IssueCard } from './IssuesStep';
import { LimitsBox, RawJson } from './ui';
import type { CallFn } from './useToolRun';

type Values = Record<string, string>;
interface Run {
  status: 'idle' | 'loading' | 'done' | 'error';
  data: unknown;
  error: string | null;
}

/** The order a newcomer should try the tools in; drives the "Next step" button. */
const NEXT_TOOL: Record<string, string> = {
  build_graph: 'project_overview',
  project_overview: 'find_entry_points',
  find_entry_points: 'key_files',
  key_files: 'tour_next',
  tour_next: 'find_candidate_issues',
  find_candidate_issues: 'localize_issue',
  localize_issue: 'score_first_change',
  score_first_change: 'export_guide',
};

const defaults = (spec: ToolSpec): Values => Object.fromEntries(spec.fields.map((f) => [f.name, f.default]));

/** A broad profile used only to find a sensible issue when the person left the issue number empty. */
const FALLBACK_PROFILE = { languages: ['TypeScript', 'JavaScript', 'Python', 'Go'], level: 'beginner', areas: [] as string[] };

/**
 * The tool explorer: pick any of the 12 tools, read what it does and what to type, run it against
 * the chosen server and read the result, including the graph that tour_next and explain_file draw.
 * Everything typed is checked with zod first, and the server answers the page relies on are
 * checked too. Helper calls (build_graph, find_entry_points, profile_contributor,
 * find_candidate_issues) happen only when an input was left empty, and every call shows in the log.
 */
export function ToolExplorer({ call }: { call: CallFn }) {
  const [pickedRepo, setPickedRepo] = useState<string>(REPOS[0].value);
  const [customRepo, setCustomRepo] = useState<string>('');
  const repo = repoArgOf(pickedRepo, customRepo);
  const repoCheck = repoSchema.safeParse(repo);
  const repoError = pickedRepo === CUSTOM_REPO && customRepo.trim() !== '' && !repoCheck.success ? repoCheck.error.issues[0].message : null;

  const [selected, setSelected] = useState<string>('build_graph');
  const [pending, setPending] = useState<{ nonce: number; values: Values } | null>(null);
  const snapshots = useRef(new Map<string, string>());
  const spec = TOOL_SPECS.find((t) => t.name === selected) ?? TOOL_SPECS[0];

  const ensureSnapshot = useCallback(async (): Promise<string> => {
    const checked = repoSchema.safeParse(repo);
    if (!checked.success) throw new Error(checked.error.issues[0].message);
    const cached = snapshots.current.get(repo);
    if (cached) return cached;
    const built = parseResponse(buildGraphResponse, await call('build_graph', { repo: checked.data }), 'build_graph');
    if (built.status !== 'ready' || !built.snapshotId) throw new Error(built.message || 'The server could not build this repo.');
    snapshots.current.set(repo, built.snapshotId);
    return built.snapshotId;
  }, [call, repo]);

  const explain = useCallback((path: string) => {
    setSelected('explain_file');
    setPending({ nonce: Date.now(), values: { path } });
  }, []);

  const pick = (name: string): void => {
    setSelected(name);
    setPending(null);
  };

  return (
    <div className="tx">
      <aside className="tx-side" aria-label="Tools">
        <div className="dm-form col tx-repo">
          <RepoPicker
            value={pickedRepo}
            custom={customRepo}
            error={repoError}
            onChange={(v, c) => {
              setPickedRepo(v);
              setCustomRepo(c);
            }}
          />
          {pickedRepo === CUSTOM_REPO && !repoError && <span className="muted dm-small">Any public GitHub repo. The first run builds it (up to about 40 seconds).</span>}
        </div>
        {GROUPS.map((g) => (
          <div key={g}>
            <h2 className="tx-group">{GROUP_INFO[g].title}</h2>
            <ul className="tx-list">
              {TOOL_SPECS.filter((t) => t.group === g).map((t) => (
                <li key={t.name}>
                  <button type="button" className="tx-item" aria-current={t.name === selected ? 'true' : undefined} onClick={() => pick(t.name)}>
                    <span className="tx-item-name">{t.name}</span>
                    <span className="tx-item-title">{t.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
      <ToolPanel
        key={`${pickedRepo}:${spec.name}:${pending?.nonce ?? 0}`}
        spec={spec}
        call={call}
        repo={repo}
        ensureSnapshot={ensureSnapshot}
        initial={pending?.values}
        onExplain={explain}
        onPick={pick}
      />
    </div>
  );
}

function FieldInput({ f, value, error, onChange }: { f: Field; value: string; error?: string; onChange: (v: string) => void }) {
  const id = useId();
  const helpId = `${id}-help`;
  const errId = `${id}-err`;
  const label = f.label.replace(/\s*\(optional\)\s*$/i, '');
  return (
    <div className="tx-field">
      <label htmlFor={id}>
        {label} <span className={`label ${f.required ? 'label-accent' : ''}`}>{f.required ? 'required' : 'optional'}</span>
      </label>
      {f.kind === 'select' ? (
        <Select id={id} value={value} options={f.options ?? []} onChange={onChange} invalid={Boolean(error)} describedBy={helpId} />
      ) : (
        <input
          id={id}
          className={`dm-input wide${f.kind === 'text' ? ' mono' : ''}`}
          type={f.kind === 'number' ? 'number' : 'text'}
          inputMode={f.kind === 'number' ? 'numeric' : undefined}
          value={value}
          placeholder={f.placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-describedby={error ? `${helpId} ${errId}` : helpId}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <span className="tx-help" id={helpId}>
        {f.help}
      </span>
      {f.example && value !== f.example && (
        <button type="button" className="dm-link tx-example" onClick={() => onChange(f.example ?? '')}>
          Use example: <code>{f.example}</code>
        </button>
      )}
      {error && (
        <span className="tx-error" id={errId} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

function ToolPanel({
  spec,
  call,
  repo,
  ensureSnapshot,
  initial,
  onExplain,
  onPick,
}: {
  spec: ToolSpec;
  call: CallFn;
  repo: string;
  ensureSnapshot: () => Promise<string>;
  initial?: Values;
  onExplain: (path: string) => void;
  onPick: (tool: string) => void;
}) {
  const [values, setValues] = useState<Values>({ ...defaults(spec), ...initial });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [run, setRun] = useState<Run>({ status: 'idle', data: null, error: null });
  const seq = useRef(0);
  const alive = useRef(true);
  const ranInitial = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const set = (name: string, v: string): void => {
    setValues((s) => ({ ...s, [name]: v }));
    setErrors((e) => {
      if (!e[name]) return e;
      const rest = { ...e };
      delete rest[name];
      return rest;
    });
  };

  const profileOf = async (d: { languages: string[]; level: string; areas: string[] }): Promise<Record<string, unknown>> => {
    const raw = await call('profile_contributor', { languages: d.languages, level: d.level, ...(d.areas.length ? { familiarAreas: d.areas } : {}) });
    return parseResponse(profileResponse, raw, 'profile_contributor').profile;
  };

  const issueOf = async (snapshotId: string, given: number | undefined): Promise<number> => {
    if (given !== undefined) return given;
    const profile = await profileOf(FALLBACK_PROFILE);
    const found = parseResponse(candidatesResponse, await call('find_candidate_issues', { snapshotId, profile, limit: 5 }), 'find_candidate_issues');
    const first = found.candidates[0];
    if (!first) throw new Error("No suitable open issue was found for this repo, so there is nothing to pick automatically. Type an issue number from the repo's Issues tab.");
    return first.number;
  };

  const firstEntry = async (snapshotId: string): Promise<string> => {
    const found = parseResponse(entryPointsResponse, await call('find_entry_points', { snapshotId }), 'find_entry_points');
    const path = found.entryPoints[0]?.path;
    if (!path) throw new Error('This repo has no entry point to start from. Type a file path, for example src/index.ts.');
    return path;
  };

  const execute = async (d: Record<string, unknown>): Promise<unknown> => {
    if (spec.name === 'build_graph') {
      const r = repoSchema.safeParse(repo);
      if (!r.success) throw new Error(r.error.issues[0].message);
      return call('build_graph', toolArgs('build_graph', d, { repo: r.data }));
    }
    const snapshotId = await ensureSnapshot();
    const profileData = d as { languages: string[]; level: string; areas: string[] };
    const extra: ToolArgExtra = { snapshotId };
    // Fill in what the person left empty: an entry file, a file to explain, an issue, a profile.
    if (spec.name === 'trace_flow') extra.entry = (d.entry as string) || (await firstEntry(snapshotId));
    if (spec.name === 'explain_file') extra.path = (d.path as string) || (await firstEntry(snapshotId));
    if (spec.name === 'find_candidate_issues' || spec.name === 'score_first_change') extra.profile = await profileOf(profileData);
    if (spec.name === 'localize_issue' || spec.name === 'score_first_change') extra.issueNumber = await issueOf(snapshotId, d.issueNumber as number | undefined);
    return call(spec.name, toolArgs(spec.name, d, extra));
  };

  const go = async (v: Values = values): Promise<void> => {
    const checked = validateForm(spec.name, v);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    const mine = ++seq.current;
    setRun((s) => ({ status: 'loading', data: s.data, error: null }));
    try {
      const data = await execute(checked.data);
      if (alive.current && mine === seq.current) setRun({ status: 'done', data, error: null });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (alive.current && mine === seq.current) setRun((s) => ({ status: 'error', data: s.data, error: message }));
    }
  };

  useEffect(() => {
    if (initial && !ranInitial.current) {
      ranInitial.current = true;
      void go({ ...defaults(spec), ...initial });
    }
    // runs once, on mount, when the panel was opened by clicking a file
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const d = asRec(run.data);
  const loading = run.status === 'loading';
  const body: Record<string, unknown> = { ...d };
  delete body.limits;
  if (spec.widget) delete body.subgraph;
  // Issues get their own compact cards instead of a nested key/value dump.
  const issueCards = spec.name === 'find_candidate_issues' ? recList(d.candidates) : [];
  if (issueCards.length > 0) delete body.candidates;

  const previewToken = spec.name === 'export_guide' ? (exportPreviewResponse.safeParse(d).data?.confirmToken ?? '') : '';
  const stage = Number(values.stage);
  const nextTool = NEXT_TOOL[spec.name];
  const nextSpec = nextTool ? TOOL_SPECS.find((t) => t.name === nextTool) : undefined;
  const unavailable = run.status === 'done' && str(d.status) === 'unavailable';

  return (
    <section className="tx-main" aria-labelledby="tx-title">
      <div className="tx-head">
        <h2 id="tx-title">{spec.title}</h2>
        <p className="tx-code">
          <code>{spec.name}</code> <span className="label">{GROUP_INFO[spec.group].title.replace(/^\d\.\s*/, '')}</span>
          {spec.widget && <span className="label label-accent">draws a graph</span>}
        </p>
      </div>
      <p className="tx-lead">{spec.summary}</p>
      <p className="tx-when">
        <strong>Use it when:</strong> {spec.whenToUse}
      </p>

      <h3 className="tx-h">What to enter</h3>
      {spec.fields.length === 0 ? (
        <p className="tx-none">{spec.noInputNote}</p>
      ) : (
        <form
          className="tx-form"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          {spec.fields.map((f) => (
            <FieldInput key={f.name} f={f} value={values[f.name] ?? ''} error={errors[f.name]} onChange={(v) => set(f.name, v)} />
          ))}
        </form>
      )}
      <div className="dm-actions">
        {spec.name === 'export_guide' ? (
          <>
            <button type="button" className="dm-btn primary" disabled={loading} onClick={() => void go({ ...values, confirmToken: '' })}>
              {loading ? 'Running…' : 'Step 1: Preview the guide'}
            </button>
            <button type="button" className="dm-btn" disabled={loading} onClick={() => void go({ ...values, confirmToken: 'not-a-real-token' })}>
              Test the safety check
            </button>
          </>
        ) : (
          <button type="button" className="dm-btn primary" disabled={loading} onClick={() => void go()}>
            {loading ? 'Running…' : 'Run tool'}
          </button>
        )}
      </div>

      <details className="tx-returns" open>
        <summary>What you get back</summary>
        <dl>
          {spec.returns.map((r) => (
            <div key={r.name} className="tx-ret">
              <dt>{r.name}</dt>
              <dd>{r.meaning}</dd>
            </div>
          ))}
        </dl>
      </details>

      <div aria-live="polite">
        {loading && (
          <p className="dm-loading">
            <span className="dm-spin" aria-hidden="true" /> Calling {spec.name}… (building a new repo can take up to about 40 seconds)
          </p>
        )}
        {run.status === 'error' && (
          <p className="dm-error">
            <strong>Error:</strong> {run.error}
          </p>
        )}
        {run.status === 'error' && looksLikeMissingSecret(run.error ?? '') && (
          <p className="dm-notice">
            <strong>Why:</strong> {MISSING_SECRET_HINT}
          </p>
        )}
        {(run.status === 'error' ? looksLikeOldBuild(run.error ?? '') : unavailable && looksLikeOldBuild(str(d.message))) && (
          <p className="dm-notice">
            <strong>Why:</strong> {OLD_BUILD_HINT}
          </p>
        )}
      </div>

      {run.status === 'done' && (
        <div className="dm-result tx-result">
          <h3 className="tx-h">Result</h3>
          <p className="tx-read">
            <strong>How to read this:</strong> {spec.readIt}
          </p>
          {spec.widget && (
            <>
              <h4>Graph</h4>
              <GraphPanel output={run.data} onExplain={onExplain} busy={loading} />
            </>
          )}
          {previewToken && (
            <div className="dm-notice">
              <p>This is only the preview. Nothing is written anywhere. Happy with it? Press the button to get the full document.</p>
              <button
                type="button"
                className="dm-btn primary"
                disabled={loading}
                onClick={() => {
                  void go({ ...values, confirmToken: previewToken });
                }}
              >
                Step 2: Get the full draft
              </button>
            </div>
          )}
          <GenericValue value={body} onExplain={onExplain} busy={loading} />
          {issueCards.length > 0 && (
            <>
              <h4>Issues you could finish ({issueCards.length})</h4>
              <ul className="dm-issues">
                {issueCards.map((c, i) => (
                  <IssueCard key={`${String(c.number)}-${i}`} issue={c} />
                ))}
              </ul>
            </>
          )}
          <LimitsBox limits={d.limits} open />
          <RawJson value={run.data} />
          <div className="dm-actions tx-next">
            {spec.name === 'tour_next' && Number.isInteger(stage) && stage < 8 && (
              <button
                type="button"
                className="dm-btn primary"
                disabled={loading}
                onClick={() => {
                  const next = String(stage + 1);
                  set('stage', next);
                  void go({ ...values, stage: next });
                }}
              >
                Go to stop {stage + 1}
              </button>
            )}
            {nextSpec && !unavailable && (
              <button type="button" className="dm-btn" onClick={() => onPick(nextSpec.name)}>
                Next step: {nextSpec.title}
              </button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
