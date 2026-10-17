'use client';

import { useEffect, useState } from 'react';
import { CallLog } from '../../components/CallLog';
import { EndpointBox } from '../../components/EndpointBox';
import { Flow } from '../../components/Flow';
import { useMcp } from '../../components/useMcp';
import './demo.css';

export default function DemoPage() {
  const { endpoint, changeEndpoint, log, clearLog, call } = useMcp();

  // ?repo=<url> (from the home page box) pre-fills and starts the first step. undefined = not read yet.
  const [prefill, setPrefill] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    document.title = 'Live demo | RepoAtlas';
    const q = new URLSearchParams(window.location.search).get('repo');
    setPrefill(q && q.trim() ? q.trim().slice(0, 300) : null);
  }, []);

  return (
    <main id="main" className="container dm">
      <header className="dm-head">
        <span className="label label-success">Live</span>
        <h1>Live demo</h1>
        <p className="lede">
          These buttons call the real RepoAtlas MCP server straight from your browser. No AI model is involved: this page is a tool console, so you see exactly what an agent would receive. Pick a ready-made repo
          or paste the URL of any public GitHub repo in step 1. Want to run a single tool? Use the <a href="/tools/">tool explorer</a>.
        </p>
      </header>

      <EndpointBox endpoint={endpoint} onChange={changeEndpoint} />
      <CallLog entries={log} onClear={clearLog} />
      {prefill !== undefined && <Flow key={endpoint} call={call} initialRepo={prefill ?? undefined} />}

      <p className="muted dm-foot">
        Text from repos and issues is untrusted data and is shown as plain text. Results are as of the date each tool reports: four repos are precomputed, and any other public repo is built when you ask.
      </p>
    </main>
  );
}
