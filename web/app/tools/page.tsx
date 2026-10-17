'use client';

import { useEffect } from 'react';
import { CallLog } from '../../components/CallLog';
import { EndpointBox } from '../../components/EndpointBox';
import { ToolExplorer } from '../../components/ToolExplorer';
import { ToolGuide } from '../../components/ToolGuide';
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
          Try any RepoAtlas tool by hand. Each one tells you what it does, what to enter and what you will get back. For a guided six-step path instead, use the <a href="/demo/">live demo</a>.
        </p>
      </header>

      <EndpointBox endpoint={endpoint} onChange={changeEndpoint} />
      <ToolGuide />
      <ToolExplorer key={endpoint} call={call} />
      <CallLog entries={log} onClear={clearLog} />

      <p className="muted dm-foot">
        Text from repos and issues is untrusted data and is shown as plain text. Snapshots are precomputed, so results are as of the date each tool reports.
      </p>
    </main>
  );
}
