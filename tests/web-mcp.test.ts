import { describe, expect, it } from 'vitest';
import { McpError, REQUIRED_TOOLS, callTool, listTools, parseSse } from '../web/lib/mcp.js';

const sse = (payload: unknown, extra = ''): string => `${extra}event: message\ndata: ${JSON.stringify(payload)}\n\n`;
const reply = (body: string, init: ResponseInit = {}, type = 'text/event-stream'): typeof fetch =>
  (async () => new Response(body, { status: 200, headers: { 'content-type': type }, ...init })) as typeof fetch;

const toolResult = (result: Record<string, unknown>): unknown => ({ jsonrpc: '2.0', id: 1, result });

async function failure(p: Promise<unknown>): Promise<McpError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(McpError);
    return e as McpError;
  }
  throw new Error('expected McpError');
}

describe('parseSse', () => {
  it('reads one message', () => {
    expect(parseSse('event: message\ndata: {"a":1}\n\n')).toEqual([{ a: 1 }]);
  });
  it('joins multi-line data fields before parsing', () => {
    expect(parseSse('data: {"a":\ndata: 1}\n\n')).toEqual([{ a: 1 }]);
  });
  it('ignores comment and keepalive lines and handles CRLF', () => {
    const body = ': keepalive\r\n\r\nevent: message\r\ndata: {"ok":true}\r\n\r\n: ping\r\n\r\n';
    expect(parseSse(body)).toEqual([{ ok: true }]);
  });
  it('flushes a final message with no trailing blank line and skips non-JSON data', () => {
    expect(parseSse('data: not json\n\ndata: {"b":2}')).toEqual([{ b: 2 }]);
  });
});

describe('callTool', () => {
  it('sends a JSON-RPC tools/call with the MCP headers', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(sse(toolResult({ structuredContent: { ok: 1 } })), { headers: { 'content-type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    await callTool('https://example.com/mcp', 'build_graph', { repo: 'tsoa' }, { fetchFn });
    const s = seen as unknown as { url: string; init: RequestInit };
    expect(s.url).toBe('https://example.com/mcp');
    expect(s.init.method).toBe('POST');
    const headers = s.init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/json, text/event-stream');
    expect(headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(String(s.init.body)) as { jsonrpc: string; method: string; params: unknown };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.method).toBe('tools/call');
    expect(body.params).toEqual({ name: 'build_graph', arguments: { repo: 'tsoa' } });
  });

  it('prefers structuredContent over the text', async () => {
    const msg = toolResult({ structuredContent: { from: 'structured' }, content: [{ type: 'text', text: '{"from":"text"}' }] });
    const r = await callTool('http://localhost:3000/mcp', 't', {}, { fetchFn: reply(sse(msg)) });
    expect(r.data).toEqual({ from: 'structured' });
    expect(r.raw).toEqual(msg);
    expect(r.ms).toBeGreaterThanOrEqual(0);
  });

  it('falls back to JSON.parse of content[0].text', async () => {
    const msg = toolResult({ content: [{ type: 'text', text: '{"n":5}' }] });
    const r = await callTool('http://localhost:3000/mcp', 't', {}, { fetchFn: reply(sse(msg)) });
    expect(r.data).toEqual({ n: 5 });
  });

  it('falls back to the plain text when it is not JSON', async () => {
    const msg = toolResult({ content: [{ type: 'text', text: 'hello there' }] });
    const r = await callTool('http://localhost:3000/mcp', 't', {}, { fetchFn: reply(sse(msg)) });
    expect(r.data).toBe('hello there');
  });

  it('accepts a plain application/json reply', async () => {
    const msg = toolResult({ structuredContent: { plain: true } });
    const r = await callTool('http://localhost:3000/mcp', 't', {}, { fetchFn: reply(JSON.stringify(msg), {}, 'application/json') });
    expect(r.data).toEqual({ plain: true });
  });

  it('parses an SSE stream with keepalives and CRLF line endings', async () => {
    const msg = toolResult({ structuredContent: { crlf: 1 } });
    const body = `: keepalive\r\n\r\nevent: message\r\ndata: ${JSON.stringify(msg)}\r\n\r\n`;
    const r = await callTool('http://localhost:3000/mcp', 't', {}, { fetchFn: reply(body) });
    expect(r.data).toEqual({ crlf: 1 });
  });

  it('throws a tool error when result.isError is set, with the server message', async () => {
    const msg = toolResult({ isError: true, content: [{ type: 'text', text: 'No snapshot "x". Run build_graph first.' }] });
    const e = await failure(callTool('http://localhost:3000/mcp', 't', {}, { fetchFn: reply(sse(msg)) }));
    expect(e.kind).toBe('tool');
    expect(e.message).toBe('No snapshot "x". Run build_graph first.');
  });

  it('throws a protocol error for a JSON-RPC error', async () => {
    const msg = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } };
    const e = await failure(callTool('http://localhost:3000/mcp', 't', {}, { fetchFn: reply(sse(msg)) }));
    expect(e.kind).toBe('protocol');
    expect(e.message).toContain('Invalid params');
  });

  it('throws a protocol error when the reply has no result', async () => {
    const e = await failure(callTool('http://localhost:3000/mcp', 't', {}, { fetchFn: reply(': only a comment\n\n') }));
    expect(e.kind).toBe('protocol');
  });

  it('throws an http error for a 500 with a hint', async () => {
    const e = await failure(callTool('http://localhost:3000/mcp', 't', {}, { fetchFn: reply('boom', { status: 500, statusText: 'Internal Server Error' }) }));
    expect(e.kind).toBe('http');
    expect(e.message).toContain('500');
    expect(e.message).toMatch(/endpoint URL/i);
    expect(e.message).toMatch(/browser requests/i);
  });

  it('throws a network error with a hint when fetch rejects', async () => {
    const fetchFn = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const e = await failure(callTool('http://localhost:3000/mcp', 't', {}, { fetchFn }));
    expect(e.kind).toBe('network');
    expect(e.message).toMatch(/server is running/i);
  });

  it('times out when the server never answers', async () => {
    const fetchFn = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const e = await failure(callTool('http://localhost:3000/mcp', 't', {}, { fetchFn, timeoutMs: 20 }));
    expect(e.kind).toBe('timeout');
  });

  it('reports a caller abort as a network error, not a timeout', async () => {
    const fetchFn = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const ctl = new AbortController();
    const p = callTool('http://localhost:3000/mcp', 't', {}, { fetchFn, signal: ctl.signal });
    ctl.abort();
    const e = await failure(p);
    expect(e.kind).toBe('network');
  });

  it('rejects non-http endpoints without calling fetch', async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response('');
    }) as unknown as typeof fetch;
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://host/mcp', 'not a url', '']) {
      const e = await failure(callTool(bad, 't', {}, { fetchFn }));
      expect(e.kind).toBe('network');
    }
    expect(called).toBe(false);
  });
});

describe('listTools', () => {
  it('returns the tool names', async () => {
    const msg = toolResult({ tools: [{ name: 'build_graph' }, { name: 'ping_repoatlas' }, { description: 'no name' }] });
    expect(await listTools('http://localhost:3000/mcp', { fetchFn: reply(sse(msg)) })).toEqual(['build_graph', 'ping_repoatlas']);
  });

  it('throws a protocol error when there is no tool list', async () => {
    const e = await failure(listTools('http://localhost:3000/mcp', { fetchFn: reply(sse(toolResult({}))) }));
    expect(e.kind).toBe('protocol');
  });

  it('rejects a non-http endpoint', async () => {
    const e = await failure(listTools('gopher://x'));
    expect(e.kind).toBe('network');
  });

  it('lists exactly the 12 required tools', () => {
    expect(REQUIRED_TOOLS).toHaveLength(12);
    expect(new Set(REQUIRED_TOOLS).size).toBe(12);
  });
});
