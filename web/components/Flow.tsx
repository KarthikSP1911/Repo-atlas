'use client';

import { useState } from 'react';
import { ExportStep } from './ExportStep';
import { FindWorkStep, type Found } from './IssuesStep';
import { LocalizeStep } from './LocalizeStep';
import { RepoStep, type Built } from './RepoStep';
import { TourStep } from './TourStep';
import { UnderstandStep } from './UnderstandStep';
import { Card } from './ui';
import type { CallFn } from './useToolRun';

/**
 * The six cards. The page remounts this component when the endpoint changes, and the cards after
 * the first are keyed by snapshot id, so nothing is cached across endpoints or repos.
 */
export function Flow({ call }: { call: CallFn }) {
  const [built, setBuilt] = useState<Built | null>(null);
  const [found, setFound] = useState<Found | null>(null);

  const onBuilt = (b: Built | null): void => {
    setBuilt(b);
    setFound(null);
  };

  return (
    <>
      <RepoStep call={call} onBuilt={onBuilt} />
      {built ? (
        <div key={built.snapshotId}>
          <UnderstandStep call={call} snapshotId={built.snapshotId} />
          <TourStep call={call} snapshotId={built.snapshotId} />
          <FindWorkStep call={call} snapshotId={built.snapshotId} onFound={setFound} />
          <LocalizeStep call={call} snapshotId={built.snapshotId} found={found} />
          <ExportStep call={call} snapshotId={built.snapshotId} />
        </div>
      ) : (
        <>
          <Card n={2} title="Understand the project" tool="overview, entry points, key files" blurb="Project overview, entry points and the files worth reading first." locked>
            {null}
          </Card>
          <Card n={3} title="Take the guided tour" tool="tour_next" blurb="Eight stages, one tool call each, with a check question and a graph." locked>
            {null}
          </Card>
          <Card n={4} title="Find work you can finish" tool="profile_contributor, find_candidate_issues" blurb="Describe yourself, get a shortlist of issues you could finish." locked>
            {null}
          </Card>
          <Card n={5} title="Localize and score" tool="localize_issue, score_first_change" blurb="Which files an issue likely touches, and how good a first change it is." locked>
            {null}
          </Card>
          <Card n={6} title="Export a draft guide" tool="export_guide" blurb="A two-step export of an ARCHITECTURE.md draft." locked>
            {null}
          </Card>
        </>
      )}
    </>
  );
}
