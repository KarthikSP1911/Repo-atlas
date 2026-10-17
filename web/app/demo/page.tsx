'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CallLog, type LogEntry } from '../../components/CallLog';
import { EndpointBox } from '../../components/EndpointBox';
import { Flow } from '../../components/Flow';
import type { CallFn } from '../../components/useToolRun';
import { MCP_URL } from '../../lib/config';
import { callTool } from '../../lib/mcp';
import './demo.css';

const STORAGE_KEY = 'repoatlas-demo-endpoint';
const MAX_LOG = 60;

const clock = (d: Date): string => d.toTimeString().slice(0, 8);

export default function DemoPage() {
  const [endpoint, setEndpoint] = useState<string>(MCP_URL);
  const [log, setLog] = useState<LogEntry[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    document.title = 'Live demo | RepoAtlas';
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) setEndpoint(saved);
    } catch {
      // storage can be blocked (private mode): the default endpoint is fine
    }
  }, []);

  const changeEndpoint = useCallback((url: string) => {
    setEndpoint(url);
    try {
      window.localStorage.setItem(STORAGE_KEY, url);
    } catch {
      // not remembered, still works
    }
  }, []);

  const call: CallFn = useCallback(
    async (tool, args) => {
      const id = nextId.current++;
      const at = new Date();
      const started = Date.now();
      const add = (e: Omit<LogEntry, 'id' | 'time' | 'tool' | 'args'>): void => setLog((l) => [{ id, time: clock(at), tool, args, ...e }, ...l].slice(0, MAX_LOG));
      try {
        const r = await callTool(endpoint, tool, args);
        add({ ms: r.ms, ok: true, raw: r.raw });
        return r.data;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        add({ ms: Date.now() - started, ok: false, error: message, raw: { error: message } });
        throw e;
      }
    },
    [endpoint],
  );

  return (
    <main className="dm">
      <p className="dm-back">
        <a href="/">RepoAtlas</a>
      </p>
      <header>
        <h1>Live demo</h1>
        <p className="lede">
          These buttons call the real RepoAtlas MCP server straight from your browser. No AI model is involved: this page is a tool console, so you see exactly what an agent would receive.
        </p>
      </header>

      <EndpointBox endpoint={endpoint} onChange={changeEndpoint} />
      <CallLog entries={log} onClear={() => setLog([])} />
      <Flow key={endpoint} call={call} />

      <footer>
        Text from repos and issues is untrusted data and is shown as plain text. Snapshots are precomputed, so results are as of the date each tool reports.
      </footer>
    </main>
  );
}
