'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MCP_URL } from '../lib/config';
import { callTool } from '../lib/mcp';
import { endpointSchema } from '../lib/schemas';
import type { LogEntry } from './CallLog';
import type { CallFn } from './useToolRun';

const STORAGE_KEY = 'repoatlas-demo-endpoint';
const MAX_LOG = 60;

const clock = (d: Date): string => d.toTimeString().slice(0, 8);

/** The endpoint (remembered in this browser), the log of every call, and the caller the cards use. Shared by the demo and the tool explorer. */
export function useMcp(): { endpoint: string; changeEndpoint: (url: string) => void; log: LogEntry[]; clearLog: () => void; call: CallFn } {
  const [endpoint, setEndpoint] = useState<string>(MCP_URL);
  const [log, setLog] = useState<LogEntry[]>([]);
  const nextId = useRef(1);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      const ok = saved ? endpointSchema.safeParse(saved) : null;
      if (ok?.success) setEndpoint(ok.data);
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
        // A first build of a repo that is not precomputed can take up to about 40 seconds.
        const r = await callTool(endpoint, tool, args, tool === 'build_graph' ? { timeoutMs: 90_000 } : undefined);
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

  return { endpoint, changeEndpoint, log, clearLog: () => setLog([]), call };
}
