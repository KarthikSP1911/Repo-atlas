'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { TOOL_SPECS, GROUPS, type Field, type ToolSpec } from '../lib/tool-specs';
import { GenericValue } from './GenericValue';
import { GraphPanel } from './GraphPanel';
import { MISSING_SECRET_HINT, OLD_BUILD_HINT, REPOS, asRec, looksLikeMissingSecret, looksLikeOldBuild, recList, repoArgOf, str } from './demo-util';
import { RepoPicker } from './RepoPicker';
import { LimitsBox, RawJson } from './ui';
import type { CallFn } from './useToolRun';

type Values = Record<string, string>;
interface Run {
  status: 'idle' | 'loading' | 'done' | 'error';
  data: unknown;
  error: string | null;
}

const defaults = (spec: ToolSpec): Values => Object.fromEntries(spec.fields.map((f) => [f.name, f.default]));
const list = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const optInt = (label: string, s: string, min: number, max: number): number | undefined => {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
};

/**
 * The tool explorer: pick any of the 12 tools, fill in its inputs, run it against the chosen
 * server and see the result, including the widget graph for tour_next and explain_file. Helper
 * calls (build_graph, find_entry_points, profile_contributor, find_candidate_issues) happen only
 * when an input was left empty, and every call shows in the log above.
 */
export function ToolExplorer({ call }: { call: CallFn }) {
  const [pickedRepo, setPickedRepo] = useState<string>(REPOS[0].value);
  const [customRepo, setCustomRepo] = useState<string>('');
  const repo = repoArgOf(pickedRepo, customRepo);
  const [selected, setSelected] = useState<string>('build_graph');
  const [pending, setPending] = useState<{ nonce: number; values: Values } | null>(null);
  const snapshots = useRef(new Map<string, string>());
  const spec = TOOL_SPECS.find((t) => t.name === selected) ?? TOOL_SPECS[0];

  const ensureSnapshot = useCallback(async (): Promise<string> => {
    const cached = snapshots.current.get(repo);
    if (cached) return cached;
    if (!repo) throw new Error('Enter a GitHub repo URL or owner/repo first.');
    const built = asRec(await call('build_graph', { repo }));
    const id = str(built.snapshotId);
    if (!id) throw new Error(str(built.message) || 'build_graph did not return a snapshot id.');
    snapshots.current.set(repo, id);
    return id;
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
            onChange={(v, c) => {
              setPickedRepo(v);
              setCustomRepo(c);
            }}
          />
          {pickedRepo === '__custom' && <span className="muted dm-small">Any public GitHub repo. The first run builds it (up to about 40 seconds).</span>}
        </div>
        {GROUPS.map((g) => (
          <div key={g}>
            <h2 className="tx-group">{g}</h2>
            <ul className="tx-list">
              {TOOL_SPECS.filter((t) => t.group === g).map((t) => (
                <li key={t.name}>
                  <button type="button" className="tx-item" aria-current={t.name === selected ? 'true' : undefined} onClick={() => pick(t.name)}>
                    {t.name}
                    {t.widget && <span className="label label-accent">widget</span>}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </aside>
      <ToolPanel key={`${pickedRepo}:${spec.name}:${pending?.nonce ?? 0}`} spec={spec} call={call} repo={repo} ensureSnapshot={ensureSnapshot} initial={pending?.values} onExplain={explain} />
    </div>
  );
}

function FieldInput({ f, value, onChange }: { f: Field; value: string; onChange: (v: string) => void }) {
  const id = useId();
  return (
    <div className="tx-field">
      <label htmlFor={id}>{f.label}</label>
      {f.kind === 'select' ? (
        <select id={id} className="dm-input" value={value} onChange={(e) => onChange(e.target.value)}>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
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
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {f.help && <span className="muted dm-small">{f.help}</span>}
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
}: {
  spec: ToolSpec;
  call: CallFn;
  repo: string;
  ensureSnapshot: () => Promise<string>;
  initial?: Values;
  onExplain: (path: string) => void;
}) {
  const [values, setValues] = useState<Values>({ ...defaults(spec), ...initial });
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

  const set = (name: string, v: string): void => setValues((s) => ({ ...s, [name]: v }));

  const profileOf = async (v: Values): Promise<Record<string, unknown>> => {
    const languages = list(v.languages ?? '');
    if (languages.length === 0) throw new Error('Enter at least one language.');
    const familiarAreas = list(v.areas ?? '').slice(0, 10);
    const p = asRec(await call('profile_contributor', { languages, level: v.level || 'beginner', ...(familiarAreas.length ? { familiarAreas } : {}) }));
    const profile = asRec(p.profile);
    if (Object.keys(profile).length === 0) throw new Error('profile_contributor returned no profile.');
    return profile;
  };

  const issueOf = async (snapshotId: string, v: Values, profile: Record<string, unknown>): Promise<number> => {
    const given = optInt('Issue number', v.issueNumber ?? '', 1, 1_000_000);
    if (given !== undefined) return given;
    const c = asRec(await call('find_candidate_issues', { snapshotId, profile, limit: 5 }));
    const first = recList(c.candidates)[0];
    const n = first ? Number(first.number) : NaN;
    if (!Number.isInteger(n)) throw new Error('No candidate issue was found for this repo and profile. Type an issue number.');
    return n;
  };

  const firstEntry = async (snapshotId: string): Promise<string> => {
    const e = recList(asRec(await call('find_entry_points', { snapshotId })).entryPoints)[0];
    const path = e ? str(e.path) : '';
    if (!path) throw new Error('This repo has no entry points to start from. Type a file path.');
    return path;
  };

  const execute = async (v: Values): Promise<unknown> => {
    if (!repo) throw new Error('Enter a GitHub repo URL or owner/repo first.');
    if (spec.name === 'build_graph') return call('build_graph', { repo });
    const snapshotId = await ensureSnapshot();
    switch (spec.name) {
      case 'project_overview':
      case 'find_entry_points':
        return call(spec.name, { snapshotId });
      case 'key_files': {
        const limit = optInt('Max files per tier', v.limit ?? '', 1, 50);
        return call('key_files', { snapshotId, role: v.role, ...(limit ? { limit } : {}) });
      }
      case 'trace_flow': {
        const depth = optInt('Import hops', v.depth ?? '', 1, 6);
        const maxFiles = optInt('Max files', v.maxFiles ?? '', 1, 40);
        const entry = (v.entry ?? '').trim() || (await firstEntry(snapshotId));
        return call('trace_flow', { snapshotId, entry, ...(depth ? { depth } : {}), ...(maxFiles ? { maxFiles } : {}) });
      }
      case 'explain_file': {
        const path = (v.path ?? '').trim() || (await firstEntry(snapshotId));
        return call('explain_file', { snapshotId, path });
      }
      case 'tour_next': {
        const stage = optInt('Stage', v.stage ?? '', 1, 8);
        if (stage === undefined) throw new Error('Stage must be a whole number from 1 to 8.');
        return call('tour_next', { snapshotId, role: v.role, stage });
      }
      case 'profile_contributor': {
        const languages = list(v.languages ?? '');
        if (languages.length === 0) throw new Error('Enter at least one language.');
        const familiarAreas = list(v.areas ?? '').slice(0, 10);
        return call('profile_contributor', { languages, level: v.level || 'beginner', ...(familiarAreas.length ? { familiarAreas } : {}) });
      }
      case 'find_candidate_issues': {
        const limit = optInt('How many', v.limit ?? '', 1, 25) ?? 10;
        const profile = await profileOf(v);
        return call('find_candidate_issues', { snapshotId, profile, limit });
      }
      case 'localize_issue': {
        const profile = await profileOf({ ...defaults(spec), languages: 'TypeScript', level: 'beginner' });
        return call('localize_issue', { snapshotId, issueNumber: await issueOf(snapshotId, v, profile) });
      }
      case 'score_first_change': {
        const profile = await profileOf(v);
        return call('score_first_change', { snapshotId, issueNumber: await issueOf(snapshotId, v, profile), profile });
      }
      case 'export_guide': {
        const token = (v.confirmToken ?? '').trim();
        return call('export_guide', { snapshotId, ...(token ? { confirmToken: token } : {}) });
      }
      default:
        throw new Error(`Unknown tool ${spec.name}`);
    }
  };

  const go = async (v: Values = values): Promise<void> => {
    const mine = ++seq.current;
    setRun((s) => ({ status: 'loading', data: s.data, error: null }));
    try {
      const data = await execute(v);
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
  const token = spec.name === 'export_guide' ? str(d.confirmToken) : '';

  return (
    <section className="tx-main" aria-labelledby="tx-title">
      <div className="tx-head">
        <h2 id="tx-title">
          <code>{spec.name}</code> <span className="label">{spec.group}</span>
          {spec.widget && <span className="label label-accent">widget</span>}
        </h2>
        <p className="muted">{spec.summary}</p>
      </div>
      <form
        className="tx-form"
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        {spec.fields.map((f) => (
          <FieldInput key={f.name} f={f} value={values[f.name] ?? ''} onChange={(v) => set(f.name, v)} />
        ))}
        <div className="dm-actions">
          <button type="submit" className="dm-btn primary" disabled={loading}>
            {loading ? 'Running…' : 'Run tool'}
          </button>
          {spec.name === 'export_guide' && (
            <button type="button" className="dm-btn" disabled={loading} onClick={() => void go({ ...values, confirmToken: 'not-a-real-token' })}>
              Try a wrong token
            </button>
          )}
        </div>
      </form>

      <div aria-live="polite">
        {loading && (
          <p className="dm-loading">
            <span className="dm-spin" aria-hidden="true" /> Calling {spec.name}…
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
        {(run.status === 'error' ? looksLikeOldBuild(run.error ?? '') : run.status === 'done' && str(d.status) === 'unavailable' && looksLikeOldBuild(str(d.message))) && (
          <p className="dm-notice">
            <strong>Why:</strong> {OLD_BUILD_HINT}
          </p>
        )}
      </div>

      {run.status === 'done' && (
        <div className="dm-result">
          {spec.widget && (
            <>
              <h3>Widget</h3>
              <GraphPanel output={run.data} onExplain={onExplain} busy={loading} />
            </>
          )}
          {token && (
            <div className="dm-notice">
              <p>
                This is the preview. Nothing is written anywhere. To get the draft, confirm with the token.
              </p>
              <button
                type="button"
                className="dm-btn primary"
                disabled={loading}
                onClick={() => {
                  set('confirmToken', token);
                  void go({ ...values, confirmToken: token });
                }}
              >
                I confirm: get the draft
              </button>
            </div>
          )}
          <h3>Result</h3>
          <GenericValue value={body} onExplain={onExplain} busy={loading} />
          <LimitsBox limits={d.limits} open />
          <RawJson value={run.data} />
        </div>
      )}
    </section>
  );
}
