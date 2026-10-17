'use client';

import { useId, useState } from 'react';
import { REPOS, TIER_MEANING, asRec, fmtDate, num, str } from './demo-util';
import { Card, LimitsBox, RawJson, RunStatus } from './ui';
import { useToolRun, type CallFn } from './useToolRun';

export interface Built {
  snapshotId: string;
  repo: string;
  data: Record<string, unknown>;
}

/** Card 1: pick a repo and call build_graph. */
export function RepoStep({ call, onBuilt }: { call: CallFn; onBuilt: (b: Built | null) => void }) {
  const [repo, setRepo] = useState<string>(REPOS[0].value);
  const { state, run, reset } = useToolRun(call);
  const selectId = useId();

  const build = async (): Promise<void> => {
    onBuilt(null);
    const data = await run('build_graph', { repo });
    const d = asRec(data);
    const snapshotId = str(d.snapshotId);
    if (snapshotId) onBuilt({ snapshotId, repo: str(d.repo) || repo, data: d });
  };

  const d = asRec(state.data);
  const tier = num(d.tier);
  const stats = asRec(d.stats);
  const limits = asRec(d.limits);
  return (
    <Card n={1} title="Choose a repo" tool="build_graph" blurb="Loads a ready-made snapshot of the repo: its files, import graph, history and people. Every other tool takes the snapshot id it returns." locked={false}>
      <div className="dm-form">
        <label htmlFor={selectId}>Repo</label>
        <select
          id={selectId}
          className="dm-input"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value);
            reset();
            onBuilt(null);
          }}
        >
          {REPOS.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <button type="button" className="dm-btn primary" onClick={() => void build()} disabled={state.status === 'loading'}>
          {state.status === 'loading' ? 'Building…' : 'Build graph'}
        </button>
      </div>
      <RunStatus state={state} label="build_graph" onRetry={() => void build()} />
      {state.status === 'done' && (
        <div className="dm-result">
          <dl className="dm-dl">
            <div className="dm-row">
              <dt>Repo</dt>
              <dd>
                {str(d.repo)} <span className="muted">(snapshot {str(d.snapshotId)})</span>
              </dd>
            </div>
            <div className="dm-row">
              <dt>Tier</dt>
              <dd>
                {tier !== null ? `Tier ${tier}` : 'unknown'}
                <span className="muted"> {str(limits.tierNote) || (tier !== null ? TIER_MEANING[tier] : '') || ''}</span>
              </dd>
            </div>
            <div className="dm-row">
              <dt>Files</dt>
              <dd>
                {num(stats.files) ?? '?'} files in {num(stats.dirs) ?? '?'} folders, {num(stats.importEdges) ?? 0} import edges, {num(stats.people) ?? 0} people
              </dd>
            </div>
            <div className="dm-row">
              <dt>Commit window</dt>
              <dd>
                Last {num(d.commitWindow) ?? '?'} commits ({num(stats.commitsInGraph) ?? '?'} in the graph, {num(stats.mergedPrs) ?? 0} merged pull requests)
              </dd>
            </div>
            <div className="dm-row">
              <dt>As of</dt>
              <dd>{fmtDate(d.asOf)}</dd>
            </div>
            <div className="dm-row">
              <dt>Truncated</dt>
              <dd>{d.truncated === true ? 'Yes: size caps were applied, so this is a partial graph.' : 'No'}</dd>
            </div>
          </dl>
          <LimitsBox limits={d.limits} open />
          <RawJson value={state.data} />
        </div>
      )}
    </Card>
  );
}
