'use client';

import { Select } from './Select';
import { useId, useState } from 'react';
import { DossierPanel, useExplain, type ExplainHandle } from './Dossier';
import { ROLES, asRec, num, recList, str, strList } from './demo-util';
import { Card, Chips, FileButton, LimitsBox, RawJson, RunStatus } from './ui';
import { useToolRun, type CallFn } from './useToolRun';

function Overview({ call, snapshotId }: { call: CallFn; snapshotId: string }) {
  const { state, run } = useToolRun(call);
  const go = (): void => void run('project_overview', { snapshotId });
  const d = asRec(state.data);
  const steps = recList(d.runSteps);
  const folders = recList(d.folders);
  return (
    <div className="dm-sub">
      <h3>
        What is this project? <span className="dm-tool">project_overview</span>
      </h3>
      <button type="button" className="dm-btn" onClick={go} disabled={state.status === 'loading'}>
        Run project_overview
      </button>
      <RunStatus state={state} label="project_overview" onRetry={go} />
      {state.status === 'done' && (
        <div className="dm-result">
          <p>
            <strong>{str(d.name) || str(d.repo)}</strong>
            {str(d.license) ? <span className="muted"> ({str(d.license)})</span> : null}
          </p>
          {str(d.description) && <p>{str(d.description)}</p>}
          <p className="muted">
            Main language {str(d.primaryLanguage) || 'unknown'}, package manager {str(d.packageManager) || 'none detected'}, default branch {str(d.defaultBranch) || 'unknown'}.
          </p>
          <Chips items={strList(d.stack)} label="Stack" />
          <h4>How to run it</h4>
          {steps.length === 0 ? (
            <p className="muted">No run steps were found.</p>
          ) : (
            <ul className="dm-list">
              {steps.map((s, i) => (
                <li key={i}>
                  <span className="muted">{str(s.step)}:</span> <code>{str(s.command)}</code>{' '}
                  {s.inferred === true ? <span className="dm-tag" title="A convention for the detected tooling, not read from the repo">inferred</span> : null}
                  <span className="muted"> from {str(s.source)}</span>
                </li>
              ))}
            </ul>
          )}
          <h4>Folders</h4>
          <div className="dm-tablewrap">
            <table className="dm-table">
              <thead>
                <tr>
                  <th scope="col">Folder</th>
                  <th scope="col">Files</th>
                  <th scope="col">Role</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {folders.map((f, i) => (
                  <tr key={i}>
                    <td>
                      <code>{str(f.path)}</code>
                    </td>
                    <td>{num(f.files)}</td>
                    <td>{str(f.role)}</td>
                    <td className="muted">{str(f.evidence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {strList(d.evidence).length > 0 && (
            <ul className="dm-list muted">
              {strList(d.evidence).map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          <LimitsBox limits={d.limits} />
          <RawJson value={state.data} />
        </div>
      )}
    </div>
  );
}

function EntryPoints({ call, snapshotId, explain }: { call: CallFn; snapshotId: string; explain: ExplainHandle }) {
  const { state, run } = useToolRun(call);
  const go = (): void => void run('find_entry_points', { snapshotId });
  const d = asRec(state.data);
  const entries = recList(d.entryPoints);
  const likely = recList(d.likelyPublicFiles);
  return (
    <div className="dm-sub">
      <h3>
        Where does it start? <span className="dm-tool">find_entry_points</span>
      </h3>
      <button type="button" className="dm-btn" onClick={go} disabled={state.status === 'loading'}>
        Run find_entry_points
      </button>
      <RunStatus state={state} label="find_entry_points" onRetry={go} />
      {state.status === 'done' && (
        <div className="dm-result">
          {str(d.notice) && <p className="dm-notice">{str(d.notice)}</p>}
          {entries.length === 0 && !str(d.notice) && <p className="muted">No entry points were found.</p>}
          {entries.map((e, i) => (
            <div key={i} className="dm-mini">
              <p>
                <FileButton path={str(e.path)} onExplain={explain.explain} busy={explain.busy} /> <span className="dm-tag">{str(e.kind)}</span>
                {num(e.score) !== null ? <span className="muted"> score {num(e.score)}</span> : null}
              </p>
              <p className="muted">Why: {strList(e.reasons).join('; ') || 'not given'}</p>
              {recList(e.firstChain).length > 1 && (
                <ol className="dm-chain" aria-label="First import chain">
                  {recList(e.firstChain).map((c, j) => (
                    <li key={j} style={{ marginLeft: `${Math.min(num(c.depth) ?? 0, 6) * 14}px` }}>
                      <FileButton path={str(c.path)} onExplain={explain.explain} busy={explain.busy} /> <span className="muted">{str(c.via)}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
          {likely.length > 0 && (
            <>
              <h4>Likely public files</h4>
              <ul className="dm-list">
                {likely.map((f, i) => (
                  <li key={i}>
                    <FileButton path={str(f.path)} onExplain={explain.explain} busy={explain.busy} /> <span className="muted">{str(f.why)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <LimitsBox limits={d.limits} />
          <RawJson value={state.data} />
        </div>
      )}
    </div>
  );
}

function ScoredList({ items, explain }: { items: Record<string, unknown>[]; explain: ExplainHandle }) {
  if (items.length === 0) return <p className="muted">none</p>;
  return (
    <ul className="dm-list">
      {items.map((f, i) => (
        <li key={i}>
          <FileButton path={str(f.path)} onExplain={explain.explain} busy={explain.busy} /> <span className="dm-tag">score {num(f.score)?.toFixed(2)}</span>
          <div className="muted">{str(f.reason)}</div>
        </li>
      ))}
    </ul>
  );
}

function KeyFiles({ call, snapshotId, explain }: { call: CallFn; snapshotId: string; explain: ExplainHandle }) {
  const { state, run } = useToolRun(call);
  const [role, setRole] = useState<string>('new_dev');
  const roleId = useId();
  const go = (): void => void run('key_files', { snapshotId, role });
  const d = asRec(state.data);
  const tiers = asRec(d.tiers);
  const skip = asRec(tiers.skipForNow);
  return (
    <div className="dm-sub">
      <h3>
        Which files matter? <span className="dm-tool">key_files</span>
      </h3>
      <div className="dm-form">
        <label htmlFor={roleId}>Reading as</label>
        <Select id={roleId} value={role} options={ROLES} onChange={setRole} />
        <button type="button" className="dm-btn" onClick={go} disabled={state.status === 'loading'}>
          Run key_files
        </button>
      </div>
      <RunStatus state={state} label="key_files" onRetry={go} />
      {state.status === 'done' && (
        <div className="dm-result">
          <h4>Must read ({recList(tiers.mustRead).length})</h4>
          <ScoredList items={recList(tiers.mustRead)} explain={explain} />
          <h4>Read next ({recList(tiers.readNext).length})</h4>
          <ScoredList items={recList(tiers.readNext)} explain={explain} />
          <p className="muted">
            Skip for now: {num(skip.count) ?? 0} files{strList(skip.examples).length > 0 ? ` (for example ${strList(skip.examples).slice(0, 3).join(', ')})` : ''}.
          </p>
          {str(d.formula) && <p className="muted">Ranking formula: {str(d.formula)}</p>}
          {strList(d.notes).length > 0 && (
            <ul className="dm-list muted">
              {strList(d.notes).map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <LimitsBox limits={d.limits} />
          <RawJson value={state.data} />
        </div>
      )}
    </div>
  );
}

/** Card 2: project overview, entry points, key files. Every file path explains itself on click. */
export function UnderstandStep({ call, snapshotId }: { call: CallFn; snapshotId: string }) {
  const explain = useExplain(call, snapshotId);
  return (
    <Card n={2} title="Understand the project" tool="overview, entry points, key files" blurb="Three read-only tools. Click any file path to open its dossier (explain_file)." locked={false}>
      <Overview call={call} snapshotId={snapshotId} />
      <EntryPoints call={call} snapshotId={snapshotId} explain={explain} />
      <KeyFiles call={call} snapshotId={snapshotId} explain={explain} />
      <DossierPanel handle={explain} />
    </Card>
  );
}
