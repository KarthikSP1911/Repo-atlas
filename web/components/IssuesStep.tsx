'use client';

import { Select } from './Select';
import { useId, useState } from 'react';
import { LANGUAGES, LEVELS, asRec, fmtDate, num, recList, str, strList } from './demo-util';
import { Card, Chips, LimitsBox, RawJson, RunStatus, SafeLink } from './ui';
import { useToolRun, type CallFn } from './useToolRun';

export interface Found {
  profile: Record<string, unknown>;
  candidates: Record<string, unknown>[];
}

export function IssueCard({ issue }: { issue: Record<string, unknown> }) {
  const claim = asRec(issue.claim);
  const clarity = asRec(issue.clarity);
  const fresh = asRec(issue.freshness);
  return (
    <li className="dm-issue">
      <h4>
        <SafeLink url={issue.url}>
          #{str(issue.number)} {str(issue.title)}
        </SafeLink>
        {!str(issue.url).startsWith('https://github.com/') && (
          <>
            {' '}
            <span className="muted">(no GitHub link)</span>
          </>
        )}
      </h4>
      <Chips items={strList(issue.labels)} label="Labels" />
      <p className="muted">
        Rank score {num(issue.rankScore)?.toFixed(2) ?? '?'}, {num(issue.commentCount) ?? 0} comments, last activity {num(fresh.daysSinceActivity) ?? '?'} days ago.
      </p>
      <p>
        <span className="dm-tag">{str(claim.label) || 'claim unknown'}</span>{' '}
        <span className="muted">{strList(claim.evidence).join('; ')}</span>
      </p>
      <details>
        <summary>Why it passed the filters ({strList(issue.reasonsPassed).length} checks)</summary>
        <ul className="dm-list">
          {strList(issue.reasonsPassed).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </details>
      <details>
        <summary>Clarity signals (score {num(clarity.score)?.toFixed(2) ?? '?'})</summary>
        <ul className="dm-list">
          {strList(clarity.signals).map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </details>
    </li>
  );
}

/** Card 4: build a profile and list candidate issues. */
export function FindWorkStep({ call, snapshotId, onFound }: { call: CallFn; snapshotId: string; onFound: (f: Found | null) => void }) {
  const profileRun = useToolRun(call);
  const issuesRun = useToolRun(call);
  const [langs, setLangs] = useState<string[]>(['TypeScript']);
  const [level, setLevel] = useState<string>('beginner');
  const [areas, setAreas] = useState('');
  const levelId = useId();
  const areasId = useId();
  const busy = profileRun.state.status === 'loading' || issuesRun.state.status === 'loading';

  const go = async (): Promise<void> => {
    onFound(null);
    issuesRun.reset();
    const familiarAreas = areas.split(',').map((a) => a.trim()).filter(Boolean).slice(0, 10);
    const p = asRec(await profileRun.run('profile_contributor', { languages: langs, level, ...(familiarAreas.length ? { familiarAreas } : {}) }));
    const profile = asRec(p.profile);
    if (Object.keys(profile).length === 0) return;
    const c = asRec(await issuesRun.run('find_candidate_issues', { snapshotId, profile, limit: 10 }));
    if (Array.isArray(c.candidates)) onFound({ profile, candidates: recList(c.candidates) });
  };

  const p = asRec(profileRun.state.data);
  const c = asRec(issuesRun.state.data);
  const excluded = asRec(c.excluded);
  const candidates = recList(c.candidates);
  return (
    <Card n={4} title="Find work you can finish" tool="profile_contributor, find_candidate_issues" blurb="Say what you know; the server filters open issues down to the ones that look unclaimed, fresh, clear and not blocked." locked={false}>
      <fieldset className="dm-form col" disabled={busy}>
        <legend>Your profile</legend>
        <div className="dm-checks" role="group" aria-label="Languages you know">
          {LANGUAGES.map((l) => (
            <label key={l} className="dm-check">
              <input type="checkbox" checked={langs.includes(l)} onChange={(e) => setLangs(e.target.checked ? [...langs, l] : langs.filter((x) => x !== l))} /> {l}
            </label>
          ))}
        </div>
        <div className="dm-fields">
          <div className="dm-field">
            <label htmlFor={levelId}>Level</label>
            <Select id={levelId} value={level} onChange={setLevel} options={LEVELS.map((l) => ({ value: l, label: l.charAt(0).toUpperCase() + l.slice(1) }))} />
          </div>
          <div className="dm-field">
            <label htmlFor={areasId}>Familiar areas (optional, comma separated)</label>
            <input id={areasId} className="dm-input wide" value={areas} maxLength={200} placeholder="for example routing, cli" onChange={(e) => setAreas(e.target.value)} />
          </div>
        </div>
        <div>
          <button type="button" className="dm-btn primary" onClick={() => void go()} disabled={langs.length === 0 || busy}>
            {busy ? 'Working…' : 'Find issues'}
          </button>
          {langs.length === 0 && <span className="muted"> Pick at least one language.</span>}
        </div>
      </fieldset>
      <RunStatus state={profileRun.state} label="profile_contributor" onRetry={() => void go()} />
      {profileRun.state.status === 'done' && (
        <div className="dm-result">
          <h3>Your profile</h3>
          <ul className="dm-list">
            {strList(p.readNotes).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
          <RawJson value={profileRun.state.data} />
        </div>
      )}
      <RunStatus state={issuesRun.state} label="find_candidate_issues" onRetry={() => void go()} />
      {issuesRun.state.status === 'done' && (
        <div className="dm-result">
          <h3>
            {candidates.length} candidate issues <span className="muted">of {num(c.considered) ?? '?'} considered</span>
          </h3>
          <p className="muted">
            Issue data as of {fmtDate(c.issuesAsOf)}. Labels searched: {strList(c.labelsQueried).join(', ') || 'none'}.
          </p>
          {candidates.length === 0 && <p className="dm-notice">No issue passed every filter. See the excluded counts below.</p>}
          <ol className="dm-issues">
            {candidates.map((i, k) => (
              <IssueCard key={`${str(i.number)}-${k}`} issue={i} />
            ))}
          </ol>
          <h4>Excluded, by filter</h4>
          <ul className="dm-chips" aria-label="Excluded issue counts">
            {Object.entries(excluded).map(([k, v]) => (
              <li key={k} className="chip">
                {k}: {num(v) ?? 0}
              </li>
            ))}
          </ul>
          {recList(c.excludedExamples).length > 0 && (
            <details>
              <summary>Examples of excluded issues</summary>
              <ul className="dm-list">
                {recList(c.excludedExamples).map((e, i) => (
                  <li key={i}>
                    #{str(e.number)} {str(e.title)} <span className="muted">({str(e.reason)}: {str(e.detail)})</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
          {str(c.claimNote) && <p className="muted">{str(c.claimNote)}</p>}
          {strList(c.issueDataLimits).length > 0 && (
            <ul className="dm-list muted">
              {strList(c.issueDataLimits).map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
          <LimitsBox limits={c.limits} />
          <RawJson value={issuesRun.state.data} />
        </div>
      )}
    </Card>
  );
}
