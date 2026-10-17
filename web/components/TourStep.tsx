'use client';

import { Select } from './Select';
import { useId, useState } from 'react';
import { DossierPanel, useExplain } from './Dossier';
import { GenericValue } from './GenericValue';
import { GraphPanel } from './GraphPanel';
import { ROLES, asRec, num, str, strList } from './demo-util';
import { Card, Chips, LimitsBox, RawJson, RunStatus } from './ui';
import { useToolRun, type CallFn } from './useToolRun';

const STAGE_NAMES = ['Orient', 'Layout', 'Entry points', 'Core modules', 'Data and config', 'Tests', 'Change patterns', 'People'];

function Check({ question }: { question: Record<string, unknown> }) {
  const [shown, setShown] = useState(false);
  if (!str(question.question)) return null;
  return (
    <div className="dm-quiz">
      <h4>Check yourself</h4>
      <p>{str(question.question)}</p>
      <button type="button" className="dm-btn small" aria-expanded={shown} onClick={() => setShown(!shown)}>
        {shown ? 'Hide the answer' : 'Reveal the answer'}
      </button>
      {shown && (
        <div className="dm-answer">
          <p>
            <strong>Answer:</strong> {str(question.answer)}
          </p>
          {strList(question.evidence).length > 0 && (
            <>
              <p className="muted">Evidence:</p>
              <ul className="dm-list">
                {strList(question.evidence).map((e, i) => (
                  <li key={i}>
                    <code className="dm-path">{e}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
          {str(question.note) && <p className="muted">{str(question.note)}</p>}
        </div>
      )}
    </div>
  );
}

/** Card 3: step through the tour with tour_next, one stage per call. */
export function TourStep({ call, snapshotId }: { call: CallFn; snapshotId: string }) {
  const { state, run, reset } = useToolRun(call);
  const explain = useExplain(call, snapshotId);
  const [role, setRole] = useState<string>('new_dev');
  const [stage, setStage] = useState(1);
  const roleId = useId();

  const go = (s: number, r: string = role): void => {
    setStage(s);
    void run('tour_next', { snapshotId, role: r, stage: s });
  };
  const d = asRec(state.data);
  const done = state.data !== null;
  const stages = Array.isArray(d.stagesForRole) ? d.stagesForRole.filter((x): x is number => typeof x === 'number') : [];
  const served = num(d.stage) ?? stage;
  const idx = stages.indexOf(served);
  const prev = idx > 0 ? stages[idx - 1] : null;
  const next = num(d.nextStage);
  const bridge = asRec(d.bridge);

  return (
    <Card n={3} title="Take the guided tour" tool="tour_next" blurb="The server keeps no tour state: each call names the role and the stage. Click a file in the content or the graph to explain it." locked={false}>
      <div className="dm-form">
        <label htmlFor={roleId}>Tour for</label>
        <Select
          id={roleId}
          value={role}
          options={ROLES}
          onChange={(v) => {
            setRole(v);
            reset();
            setStage(1);
          }}
        />
        <button type="button" className="dm-btn primary" onClick={() => go(1)} disabled={state.status === 'loading'}>
          {done ? 'Restart at stage 1' : 'Start the tour'}
        </button>
      </div>
      <RunStatus state={state} label="tour_next" onRetry={() => go(stage)} />

      {done && (
        <div className="dm-result">
          <nav className="dm-stepper" aria-label="Tour stages">
            <button type="button" className="dm-btn small" onClick={() => prev !== null && go(prev)} disabled={prev === null || state.status === 'loading'}>
              Previous
            </button>
            <ol className="dm-stages">
              {stages.map((s) => (
                <li key={s}>
                  <button type="button" className={`dm-stage${s === served ? ' on' : ''}`} aria-current={s === served ? 'step' : undefined} onClick={() => go(s)} aria-label={`Stage ${s}, ${STAGE_NAMES[s - 1] ?? ''}`}>
                    {s}
                  </button>
                </li>
              ))}
            </ol>
            <button type="button" className="dm-btn small primary" onClick={() => next !== null && go(next)} disabled={next === null || state.status === 'loading'}>
              Next
            </button>
          </nav>
          <p className="muted">
            Stages for this role: {stages.join(', ') || 'none'}. {next === null ? 'This is the last stage.' : `Next stage: ${next}.`}
          </p>

          <h3>
            {str(d.progress) ? `${str(d.progress)}: ` : ''}
            {str(d.name)}
          </h3>
          {str(d.learn) && <p>{str(d.learn)}</p>}
          {str(d.notice) && <p className="dm-notice">{str(d.notice)}</p>}
          <GenericValue value={d.content} onExplain={explain.explain} busy={explain.busy} />
          <Check key={`${role}-${served}`} question={asRec(d.checkQuestion)} />
          {str(bridge.message) && (
            <div className="dm-bridge">
              <h4>Next, find something to work on</h4>
              <p>{str(bridge.message)}</p>
              <Chips items={strList(bridge.nextTools)} label="Suggested next tools" />
            </div>
          )}
          <GraphPanel output={d} onExplain={explain.explain} busy={explain.busy} />
          <LimitsBox limits={d.limits} />
          <RawJson value={state.data} />
        </div>
      )}
      <DossierPanel handle={explain} />
    </Card>
  );
}
