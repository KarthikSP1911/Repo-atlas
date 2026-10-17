'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** The demo page's tool caller: logs the call and resolves to the tool output (throws McpError). */
export type CallFn = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

export interface RunState {
  status: 'idle' | 'loading' | 'done' | 'error';
  data: unknown;
  error: string | null;
}

const IDLE: RunState = { status: 'idle', data: null, error: null };

/** Runs one tool at a time, ignoring stale answers and answers that arrive after unmount. The last good data is kept while a new call runs or fails. */
export function useToolRun(call: CallFn): { state: RunState; run: (tool: string, args: Record<string, unknown>) => Promise<unknown>; reset: () => void } {
  const [state, setState] = useState<RunState>(IDLE);
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    async (tool: string, args: Record<string, unknown>): Promise<unknown> => {
      const mine = ++seq.current;
      setState((s) => ({ status: 'loading', data: s.data, error: null }));
      try {
        const data = await call(tool, args);
        if (alive.current && mine === seq.current) setState({ status: 'done', data, error: null });
        return data;
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (alive.current && mine === seq.current) setState((s) => ({ status: 'error', data: s.data, error: message }));
        return undefined;
      }
    },
    [call],
  );

  const reset = useCallback(() => {
    seq.current++;
    setState(IDLE);
  }, []);

  return { state, run, reset };
}
