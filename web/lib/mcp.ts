/**
 * Tiny MCP client for the live demo. Plain TypeScript: only fetch and AbortController are used,
 * so it runs in the browser and under Node. It speaks JSON-RPC over HTTP (the reply may be a
 * server-sent-events stream or plain JSON) and needs no initialize step or session.
 */

export type McpErrorKind = 'network' | 'http' | 'protocol' | 'tool' | 'timeout';

const CONNECT_HINT = 'Check the endpoint URL, that the server is running, and that it allows browser requests.';

export class McpError extends Error {
  readonly kind: McpErrorKind;
  constructor(kind: McpErrorKind, message: string) {
    super(message);
    this.name = 'McpError';
    this.kind = kind;
  }
}

export interface CallOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra attempts after a transient failure (network error, 502/503/504). Default 3. */
  retries?: number;
  /** Base wait before a retry; grows linearly per attempt. Default 350. */
  retryDelayMs?: number;
}

export interface CallResult {
  /** The tool output: structuredContent if present, else the parsed JSON text, else the text. */
  data: unknown;
  /** The full JSON-RPC message, shown as "what the agent receives". */
  raw: unknown;
  ms: number;
}

const DEFAULT_TIMEOUT_MS = 45_000;
let nextId = 1;

function checkEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new McpError('network', `"${endpoint.slice(0, 120)}" is not a valid URL. Use a full address such as https://host/mcp.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new McpError('network', `Only http and https endpoints are allowed (got ${url.protocol.replace(':', '')}).`);
  }
  return url.toString();
}

/** Extract the JSON messages from a server-sent-events body (multi-line data, comments, CRLF). */
export function parseSse(body: string): unknown[] {
  const messages: unknown[] = [];
  let data: string[] = [];
  const flush = (): void => {
    if (data.length === 0) return;
    const text = data.join('\n');
    data = [];
    try {
      messages.push(JSON.parse(text));
    } catch {
      // not JSON (for example a keepalive payload): ignore
    }
  };
  for (const line of body.split(/\r\n|\r|\n/)) {
    if (line === '') flush();
    else if (line.startsWith(':')) continue;
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  flush();
  return messages;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Pick the JSON-RPC reply (the message carrying our id, else the last one with result or error). */
function pickMessage(body: string, contentType: string, id: number): Record<string, unknown> {
  let messages: unknown[];
  const trimmed = body.trim();
  if (contentType.includes('text/event-stream') || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) {
    messages = parseSse(body);
  } else {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      messages = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new McpError('protocol', `The server sent a reply that is not valid JSON. ${CONNECT_HINT}`);
    }
  }
  const records = messages.filter(isRecord);
  const replies = records.filter((m) => 'result' in m || 'error' in m);
  const mine = replies.find((m) => m.id === id) ?? replies[replies.length - 1];
  if (!mine) throw new McpError('protocol', `The server reply had no JSON-RPC result. Is this really an MCP endpoint? ${CONNECT_HINT}`);
  return mine;
}

function textOf(result: Record<string, unknown>): string {
  const content = result.content;
  if (Array.isArray(content)) {
    const first: unknown = content[0];
    if (isRecord(first) && typeof first.text === 'string') return first.text;
  }
  return '';
}

const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 350;

function isTransient(e: unknown): boolean {
  if (!(e instanceof McpError)) return false;
  if (e.kind === 'network') return e.message.startsWith('Could not reach');
  return e.kind === 'http' && /HTTP (502|503|504)\b/.test(e.message);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

/**
 * The hosted gateway sometimes answers a request with a bare 503 that carries no CORS headers, so
 * a browser reports it as a plain network failure. The calls are read-only, so retrying is safe.
 */
async function rpc(endpoint: string, method: string, params: unknown, opts: CallOptions): Promise<{ message: Record<string, unknown>; ms: number }> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const delay = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpcOnce(endpoint, method, params, opts);
    } catch (e) {
      if (attempt >= retries || opts.signal?.aborted || !isTransient(e)) throw e;
      await sleep(delay * (attempt + 1), opts.signal);
    }
  }
}

async function rpcOnce(endpoint: string, method: string, params: unknown, opts: CallOptions): Promise<{ message: Record<string, unknown>; ms: number }> {
  const url = checkEndpoint(endpoint);
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const id = nextId++;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = (): void => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }
  const started = Date.now();
  try {
    let res: Response;
    let body: string;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      body = await res.text();
    } catch (e) {
      if (timedOut) throw new McpError('timeout', `The server did not answer within ${Math.round(timeoutMs / 1000)} seconds. It may be waking up; try again. ${CONNECT_HINT}`);
      if (controller.signal.aborted) throw new McpError('network', 'The request was cancelled.');
      if (e instanceof McpError) throw e;
      throw new McpError('network', `Could not reach the server. ${CONNECT_HINT}`);
    }
    if (!res.ok) {
      throw new McpError('http', `The server answered with HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}. ${CONNECT_HINT}`);
    }
    const message = pickMessage(body, res.headers.get('content-type') ?? '', id);
    return { message, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

function rpcErrorMessage(message: Record<string, unknown>): string | null {
  if (!('error' in message) || message.error === undefined || message.error === null) return null;
  const err = message.error;
  if (isRecord(err) && typeof err.message === 'string') return err.message;
  return 'The server returned an error.';
}

/** Call one tool. Throws McpError on any failure; tool-level errors have kind "tool". */
export async function callTool(endpoint: string, name: string, args: Record<string, unknown>, opts: CallOptions = {}): Promise<CallResult> {
  const { message, ms } = await rpc(endpoint, 'tools/call', { name, arguments: args }, opts);
  const rpcErr = rpcErrorMessage(message);
  if (rpcErr !== null) throw new McpError('protocol', `The server rejected the call: ${rpcErr}`);
  const result = message.result;
  if (!isRecord(result)) throw new McpError('protocol', `The server reply had no result. ${CONNECT_HINT}`);
  if (result.isError === true) {
    throw new McpError('tool', textOf(result).replace(/^Error:\s*/, '') || `The tool ${name} reported an error without a message.`);
  }
  if (result.structuredContent !== undefined && result.structuredContent !== null) {
    return { data: result.structuredContent, raw: message, ms };
  }
  const text = textOf(result);
  if (text === '') return { data: result, raw: message, ms };
  try {
    return { data: JSON.parse(text) as unknown, raw: message, ms };
  } catch {
    return { data: text, raw: message, ms };
  }
}

/** Names of the tools the server offers (tools/list). */
export async function listTools(endpoint: string, opts: CallOptions = {}): Promise<string[]> {
  const { message } = await rpc(endpoint, 'tools/list', {}, opts);
  const rpcErr = rpcErrorMessage(message);
  if (rpcErr !== null) throw new McpError('protocol', `The server rejected tools/list: ${rpcErr}`);
  const result = message.result;
  const tools = isRecord(result) ? result.tools : undefined;
  if (!Array.isArray(tools)) throw new McpError('protocol', `The server did not return a tool list. ${CONNECT_HINT}`);
  return tools.filter(isRecord).map((t) => t.name).filter((n): n is string => typeof n === 'string');
}

/** The 12 tools the demo needs. */
export const REQUIRED_TOOLS = [
  'build_graph',
  'project_overview',
  'find_entry_points',
  'key_files',
  'trace_flow',
  'explain_file',
  'tour_next',
  'profile_contributor',
  'find_candidate_issues',
  'localize_issue',
  'score_first_change',
  'export_guide',
] as const;
