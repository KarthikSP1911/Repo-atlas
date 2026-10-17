'use client';

import { useEffect, useState } from 'react';
import { CUSTOM_REPO, OLD_BUILD_HINT, looksLikeOldBuild } from './demo-util';
import { REPOS, TIER_MEANING, asRec, fmtDate, num, repoArgOf, str } from './demo-util';
import { RepoPicker } from './RepoPicker';
import { Card, LimitsBox, RawJson, RunStatus } from './ui';
import { useToolRun, type CallFn } from './useToolRun';

export interface Built {
  snapshotId: string;
  repo: string;
  data: Record<string, unknown>;
}

/** Card 1: pick a repo and call build_graph. */
export function RepoStep({ call, onBuilt, initialRepo }: { call: CallFn; onBuilt: (b: Built | null) => void; initialRepo?: string }) {
  const [pick, setPick] = useState<string>(initialRepo ? CUSTOM_REPO : REPOS[0].value);
  const [custom, setCustom] = useState<string>(initialRepo ?? '');
  const repo = repoArgOf(pick, custom);
  const { state, run, reset } = useToolRun(call);

  const build = async (): Promise<void> => {
    if (!repo) return;
    onBuilt(null);
    const data = await run('build_graph', { repo });
    const d = asRec(data);
    const snapshotId = str(d.snapshotId);
    if (snapshotId) onBuilt({ snapshotId, repo: str(d.repo) || repo, data: d });
  };

  // Arrived from the home page box with a repo: start straight away.
  useEffect(() => {
    if (initialRepo) void build();
    // runs once, on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const d = asRec(state.data);
  const tier = num(d.tier);
  const stats = asRec(d.stats);
  const limits = asRec(d.limits);
  return (
    <Card n={1} title="Choose a repo" tool="build_graph" blurb="Loads a graph of the repo: its files, import graph, history and people. Four repos are ready-made; any other public GitHub repo is built on the spot from its URL (the first time can take up to about 40 seconds). Every other tool takes the snapshot id it returns." locked={false}>
      <div className="dm-form">
        <RepoPicker
          value={pick}
          custom={custom}
          onChange={(v, c) => {
            setPick(v);
            setCustom(c);
            reset();
            onBuilt(null);
          }}
        />
        <button type="button" className="dm-btn primary" onClick={() => void build()} disabled={state.status === 'loading' || repo === ''}>
          {state.status === 'loading' ? 'Building…' : 'Build graph'}
        </button>
      </div>
      <RunStatus state={state} label={pick === '__custom' ? 'build_graph (fetching the repo from GitHub, up to about 40 seconds)' : 'build_graph'} onRetry={() => void build()} />
      {state.status === 'done' && str(d.status) === 'unavailable' && (
        <div className="dm-result">
          <p className="dm-error">
            <strong>Could not build this repo:</strong> {str(d.message)}
          </p>
          {looksLikeOldBuild(str(d.message)) && (
            <p className="dm-notice">
              <strong>Why:</strong> {OLD_BUILD_HINT}
            </p>
          )}
          <RawJson value={state.data} />
        </div>
      )}
      {state.status === 'done' && str(d.status) !== 'unavailable' && (
        <div className="dm-result">
          <dl className="dm-dl">
            <div className="dm-row">
              <dt>Repo</dt>
              <dd>
                {str(d.repo)} <span className="muted">(snapshot {str(d.snapshotId)})</span>
              </dd>
            </div>
            <div className="dm-row">
              <dt>Source</dt>
              <dd>{str(d.source) === 'built_on_demand' ? 'Built just now from GitHub (approximate import graph; see the limits below)' : 'Precomputed ahead of time and evaluated'}</dd>
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
