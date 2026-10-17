'use client';

import { useEffect } from 'react';
import { CallLog } from '../../components/CallLog';
import { EndpointBox } from '../../components/EndpointBox';
import { ToolExplorer } from '../../components/ToolExplorer';
import { useMcp } from '../../components/useMcp';
import '../demo/demo.css';

export default function ToolsPage() {
  const { endpoint, changeEndpoint, log, clearLog, call } = useMcp();

  useEffect(() => {
    document.title = 'Tool explorer | RepoAtlas';
  }, []);

  return (
    <main id="main" className="container dm tx-page">
      <header className="dm-head">
        <span className="label label-accent">12 tools</span>
        <h1>Tool explorer</h1>
        <p className="lede">
          Run any single RepoAtlas tool against the real server and see exactly what an agent receives, including the graph widget that <code>tour_next</code> and <code>explain_file</code> draw. For the guided
          six-step path, use the <a href="/demo/">live demo</a>.
        </p>
      </header>

      <EndpointBox endpoint={endpoint} onChange={changeEndpoint} />
      <CallLog entries={log} onClear={clearLog} />
      <ToolExplorer key={endpoint} call={call} />

      <p className="muted dm-foot">
        Text from repos and issues is untrusted data and is shown as plain text. Snapshots are precomputed, so results are as of the date each tool reports.
      </p>
    </main>
  );
}
