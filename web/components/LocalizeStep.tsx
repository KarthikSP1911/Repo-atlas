'use client';

import { useState } from 'react';
import { asRec, fmtDate, num, recList, str, strList } from './demo-util';
import type { Found } from './IssuesStep';
import { Card, LimitsBox, RawJson, RunStatus, SafeLink } from './ui';
import { useToolRun, type CallFn } from './useToolRun';

function Components({ c }: { c: Record<string, unknown> }) {
  const parts = Object.entries(c).filter(([, v]) => typeof v === 'number');
  return <span className="muted">{parts.map(([k, v]) => `${k} ${(v as number).toFixed(2)}`).join(', ')}</span>;
}

function LocalizeResult({ data }: { data: unknown }) {
  const d = asRec(data);
  const files = recList(d.files);
  const order = strList(d.readingOrder);
  return (
    <div className="dm-sub">
      <h4>
        Likely files <span className="dm-tool">localize_issue</span> <span className="dm-tag">confidence {str(d.confidence) || 'unknown'}</span>
      </h4>
      <ol className="dm-list">
        {files.map((f, i) => (
          <li key={i}>
            <code className="dm-path">{str(f.path)}</code> <span className="dm-tag">score {num(f.score)?.toFixed(2)}</span>
            <div>
              <Components c={asRec(f.components)} />
            </div>
            <ul className="dm-list muted">
              {strList(f.evidence).map((e, j) => (
                <li key={j}>{e}</li>
              ))}
            </ul>
            {str(f.owner) && <div className="muted">Last owner by commits: {str(f.owner)}</div>}
          </li>
        ))}
      </ol>
      {files.length === 0 && <p className="muted">No likely files were found.</p>}
      {order.length > 0 && <p className="muted">Reading order: {order.join(', ')}</p>}
      <p className="muted">Why this confidence:</p>
      <ul className="dm-list muted">
        {strList(d.confidenceReasons).map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      {strList(d.notes).map((n, i) => (
        <p key={i} className="dm-notice">
          {n}
        </p>
      ))}
      <RawJson value={data} />
    </div>
  );
}

function ScoreResult({ data }: { data: unknown }) {
  const d = asRec(data);
  const score = num(d.score);
  return (
    <div className="dm-sub">
      <h4>
        First-change fit <span className="dm-tool">score_first_change</span>
      </h4>
      <p>
        <span className="dm-bignum">{score !== null ? score.toFixed(3) : '?'}</span> <span className="muted">overall (a product of the factors below, each floored so one weak factor cannot zero it)</span>
      </p>
      {str(d.whyItFits) && <p>{str(d.whyItFits)}</p>}
      <div className="dm-tablewrap">
        <table className="dm-table">
          <thead>
            <tr>
              <th scope="col">Factor</th>
              <th scope="col">Raw</th>
              <th scope="col">Floored</th>
              <th scope="col">Explanation</th>
            </tr>
          </thead>
          <tbody>
            {recList(d.factors).map((f, i) => (
              <tr key={i}>
                <td>{str(f.name)}</td>
                <td>{num(f.raw)?.toFixed(3)}</td>
                <td>{num(f.floored)?.toFixed(3)}</td>
                <td className="muted">{str(f.explanation)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {str(d.formula) && <p className="muted">Formula: {str(d.formula)}</p>}
      {str(d.estimatedEffort) && (
        <p>
          <strong>Effort:</strong> {str(d.estimatedEffort)}
        </p>
      )}
      {strList(d.watchOuts).length > 0 && (
        <>
          <h4>Watch out for</h4>
          <ul className="dm-list">
            {strList(d.watchOuts).map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      )}
      {strList(d.whoToAsk).length > 0 && <p className="muted">Who to ask (recent committers to these files): {strList(d.whoToAsk).join(', ')}</p>}
      <p className="muted">
        Confidence {str(d.confidence) || 'unknown'}. {strList(d.confidenceReasons).join('; ')}
      </p>
      <p className="muted">Issue data as of {fmtDate(d.issuesAsOf)}.</p>
      <LimitsBox limits={d.limits} />
      <RawJson value={data} />
    </div>
  );
}

function IssueRow({ call, snapshotId, issue, profile }: { call: CallFn; snapshotId: string; issue: Record<string, unknown>; profile: Record<string, unknown> }) {
  const loc = useToolRun(call);
  const score = useToolRun(call);
  const number = num(issue.number);
  const busy = loc.state.status === 'loading' || score.state.status === 'loading';
  const go = (): void => {
    if (number === null) return;
    void loc.run('localize_issue', { snapshotId, issueNumber: number });
    void score.run('score_first_change', { snapshotId, issueNumber: number, profile });
  };
  return (
    <li className="dm-issue">
      <h4>
        <SafeLink url={issue.url}>
          #{str(issue.number)} {str(issue.title)}
        </SafeLink>
      </h4>
      <button type="button" className="dm-btn" onClick={go} disabled={busy || number === null}>
        {busy ? 'Working…' : 'Localize and score'}
      </button>
      <RunStatus state={loc.state} label="localize_issue" onRetry={go} />
      <RunStatus state={score.state} label="score_first_change" onRetry={go} />
      {loc.state.status === 'done' && <LocalizeResult data={loc.state.data} />}
      {score.state.status === 'done' && <ScoreResult data={score.state.data} />}
    </li>
  );
}

/** Card 5: localize each candidate issue to files and score how well it fits the profile. */
export function LocalizeStep({ call, snapshotId, found }: { call: CallFn; snapshotId: string; found: Found | null }) {
  const [limit, setLimit] = useState(3);
  const list = found?.candidates ?? [];
  return (
    <Card n={5} title="Localize and score" tool="localize_issue, score_first_change" blurb="For one issue: which files it likely touches (with the evidence), and how good a first change it is for your profile." locked={found === null}>
      {found && list.length === 0 && <p className="dm-notice">No candidate issues passed the filters for this repo, so there is nothing to localize. Try another repo or profile.</p>}
      <ol className="dm-issues">
        {list.slice(0, limit).map((issue, i) => (
          <IssueRow key={`${str(issue.number)}-${i}`} call={call} snapshotId={snapshotId} issue={issue} profile={found?.profile ?? {}} />
        ))}
      </ol>
      {list.length > limit && (
        <button type="button" className="dm-link" onClick={() => setLimit(limit + 5)}>
          show more issues ({list.length - limit} hidden)
        </button>
      )}
    </Card>
  );
}
