'use client';

import { useId, useState } from 'react';
import { LOCAL_MCP_URL, MCP_URL } from '../lib/config';
import { REQUIRED_TOOLS, callTool, listTools } from '../lib/mcp';
import { endpointSchema, parseResponse, pingResponse } from '../lib/schemas';
import { OLD_BUILD_HINT } from './demo-util';

type Check = { status: 'idle' } | { status: 'loading' } | { status: 'ok'; count: number; missing: string[]; liveBuilds: boolean | null } | { status: 'error'; message: string };

/** Endpoint input, the two presets, and the "Check connection" button (tools/list). */
export function EndpointBox({ endpoint, onChange }: { endpoint: string; onChange: (url: string) => void }) {
  const [check, setCheck] = useState<Check>({ status: 'idle' });
  const inputId = useId();

  const runCheck = async (): Promise<void> => {
    const addr = endpointSchema.safeParse(endpoint);
    if (!addr.success) {
      setCheck({ status: 'error', message: addr.error.issues[0].message });
      return;
    }
    setCheck({ status: 'loading' });
    try {
      const names = await listTools(addr.data, { timeoutMs: 20_000 });
      // ping_repoatlas says whether this build can build any repo (newer builds report liveBuilds; older ones do not).
      let liveBuilds: boolean | null = null;
      try {
        const ping = parseResponse(pingResponse, (await callTool(addr.data, 'ping_repoatlas', {}, { timeoutMs: 20_000 })).data, 'ping_repoatlas');
        liveBuilds = typeof ping.liveBuilds === 'boolean' ? ping.liveBuilds : false;
      } catch {
        liveBuilds = null;
      }
      setCheck({ status: 'ok', count: names.length, missing: REQUIRED_TOOLS.filter((t) => !names.includes(t)), liveBuilds });
    } catch (e) {
      setCheck({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  const change = (url: string): void => {
    setCheck({ status: 'idle' });
    onChange(url);
  };

  return (
    <section className="dm-card" aria-labelledby="dm-endpoint-h">
      <h2 id="dm-endpoint-h">MCP server</h2>
      <div className="dm-form col">
        <label htmlFor={inputId}>Endpoint URL</label>
        <input id={inputId} type="url" className="dm-input wide mono" value={endpoint} spellCheck={false} autoComplete="off" onChange={(e) => change(e.target.value)} />
        <div className="dm-actions">
          <button type="button" className="dm-btn" onClick={() => change(MCP_URL)} aria-pressed={endpoint === MCP_URL}>
            Use live server
          </button>
          <button type="button" className="dm-btn" onClick={() => change(LOCAL_MCP_URL)} aria-pressed={endpoint === LOCAL_MCP_URL}>
            Use local server
          </button>
          <button type="button" className="dm-btn primary" onClick={() => void runCheck()} disabled={check.status === 'loading'}>
            Check connection
          </button>
        </div>
      </div>
      <div className="dm-status" aria-live="polite">
        {check.status === 'loading' && (
          <p className="dm-loading">
            <span className="dm-spin" aria-hidden="true" /> Asking the server for its tools…
          </p>
        )}
        {check.status === 'ok' && (
          <p className={check.missing.length === 0 ? 'dm-okmsg' : 'dm-error'}>
            {check.missing.length === 0
              ? `Connected. The server offers ${check.count} tools, including all 12 RepoAtlas tools.`
              : `Connected, but ${check.missing.length} required tool${check.missing.length === 1 ? ' is' : 's are'} missing: ${check.missing.join(', ')}. The server needs a redeploy.`}
          </p>
        )}
        {check.status === 'ok' && check.missing.length === 0 && check.liveBuilds === false && (
          <p className="dm-notice">
            <strong>Limited server:</strong> {OLD_BUILD_HINT}
          </p>
        )}
        {check.status === 'error' && (
          <p className="dm-error">
            <strong>Error:</strong> {check.message}
          </p>
        )}
      </div>
      <p className="muted dm-small">
        Your browser talks to this address directly; there is no proxy. A server on your own machine only works if you are on that machine and it allows browser requests (CORS).
      </p>
    </section>
  );
}
