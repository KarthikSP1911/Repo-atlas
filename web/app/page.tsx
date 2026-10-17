import data from '../data/example.json';

import { CodeBlock, CopyButton } from '../components/CopyButton';
import { Icon } from '../components/Icon';
import { GITHUB, GUIDE, MCP_URL } from '../lib/config';

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const day = (iso: string): string => iso.slice(0, 10);
const short = (p: string): string => (p.length > 58 ? `…${p.slice(-57)}` : p);

const TOOLS: { name: string; group: string; tone: string; text: string }[] = [
  { name: 'build_graph', group: 'Foundation', tone: 'label-accent', text: 'Resolves a repo to a precomputed snapshot: commit, tier, commit window, as-of time, stats.' },
  { name: 'project_overview', group: 'Understand', tone: 'label-success', text: 'Purpose, stack, run steps (marked when inferred), folder roles and entry points.' },
  { name: 'find_entry_points', group: 'Understand', tone: 'label-success', text: 'Where execution starts, with the reason, the command and the first import chain.' },
  { name: 'key_files', group: 'Understand', tone: 'label-success', text: 'Must read, Read next and Skip tiers, with every score component.' },
  { name: 'trace_flow', group: 'Understand', tone: 'label-success', text: 'The import chain from a file, in order, with the caps stated.' },
  { name: 'explain_file', group: 'Understand', tone: 'label-success', text: 'Role, exports, imports, owners, tests, recent commits and PRs. Draws the graph widget.' },
  { name: 'tour_next', group: 'Understand', tone: 'label-success', text: 'One of 8 tour stages for your role, a check question and a subgraph. Draws the graph widget.' },
  { name: 'profile_contributor', group: 'Contribute', tone: 'label-done', text: 'Languages, level, familiar areas, and what was read to decide.' },
  { name: 'find_candidate_issues', group: 'Contribute', tone: 'label-done', text: 'Open, recent, clear and likely unclaimed issues, with the evidence for each.' },
  { name: 'localize_issue', group: 'Contribute', tone: 'label-done', text: 'The top 5 files an issue would change, with evidence, owner and reading order.' },
  { name: 'score_first_change', group: 'Contribute', tone: 'label-done', text: 'A first-change score with every factor shown, an effort estimate and watch-outs.' },
  { name: 'export_guide', group: 'Action', tone: 'label-attention', text: 'Drafts an ARCHITECTURE.md. Preview first, full text only after a confirm token.' },
];

const STEPS: { icon: string; title: string; tools: string[]; text: string }[] = [
  { icon: 'book', title: 'Understand', tools: ['build_graph', 'project_overview', 'find_entry_points', 'key_files', 'trace_flow', 'explain_file'], text: 'Where execution starts, what the project is for, and the files to read first, tiered Must read, Read next and Skip for now.' },
  { icon: 'route', title: 'Take the tour', tools: ['tour_next'], text: 'Eight stages (orient, layout, entry points, core modules, config, tests, change patterns, people), adapted to your role, with a check question at each stop and a small graph drawn by a widget.' },
  { icon: 'user', title: 'Match', tools: ['profile_contributor', 'find_candidate_issues'], text: 'Keeps only issues that are open, recent, clear and likely unclaimed, and shows the evidence for each.' },
  { icon: 'target', title: 'Localize and score', tools: ['localize_issue', 'score_first_change'], text: 'Finds the files an issue would change, and shows how good a first change it is for you, factor by factor.' },
  { icon: 'export', title: 'Export', tools: ['export_guide'], text: 'Drafts an ARCHITECTURE.md. It returns a preview first and the full text only after you confirm. It never writes to your repo.' },
];

const FEATURES: { icon: string; title: string; text: string }[] = [
  { icon: 'layers', title: 'Any public repo', text: 'Four repos are precomputed and answer instantly. Any other public GitHub repo is built on demand from its URL, in seconds, with an approximate import graph and a note saying so. Private repos are not supported.' },
  { icon: 'graph', title: 'Two tiers', text: 'JavaScript, TypeScript and Python get an import graph. Every other language gets the file tree, history and people only, and every tool says so.' },
  { icon: 'clock', title: 'As of a date', text: 'Every answer states the snapshot’s commit and build date. “Likely unclaimed” is evidence, not a guarantee.' },
  { icon: 'shield', title: 'Safe by design', text: 'The one action returns text only and needs a confirmation token. Text from repos and issues is untrusted data. Building a repo reads public data from GitHub; tokens are never logged or returned.' },
];

const MCP_REMOTE = JSON.stringify({ mcpServers: { repoatlas: { command: 'npx', args: ['-y', 'mcp-remote', MCP_URL] } } }, null, 2);

export default function Home() {
  const d = data;
  const best = d.candidates[0];
  const f = d.candidateFilters;
  const a = d.accuracy;
  const repoShort = d.snapshot.repo.split('/')[1];
  const topKey = d.keyFiles[0];
  const topLocal = d.localize.files[0];

  return (
    <main id="main">
      <section className="hero" aria-labelledby="hero-h">
        <div className="container">
          <div>
            <div className="hero-tags">
              <span className="label label-accent">MCP server</span>
              <span className="label">Built on NitroStack</span>
              <span className="label">Developer Tools</span>
              <span className="label label-success">{d.tools.length} tools</span>
              <span className="label label-attention">Any public repo</span>
            </div>
            <h1 id="hero-h">Open an unfamiliar repo. Know where to start.</h1>
            <p className="lede">
              RepoAtlas turns a GitHub repo into a graph of its code, history, people and issues. An AI agent uses it to walk you through the project one step at a time, then finds the issues you can actually
              finish, with the files to touch.
            </p>
            <div className="buttons">
              <a className="btn btn-primary btn-lg" href="/demo/">
                <Icon name="play" size={16} />
                Try the live demo
              </a>
              <a className="btn btn-lg" href="/tools/">
                <Icon name="layers" size={16} />
                Explore all {d.tools.length} tools
              </a>
            </div>
            <form className="cmd cmd-form" action="/demo/" method="get">
              <label className="sr-only" htmlFor="hero-repo">
                GitHub repo URL
              </label>
              <input id="hero-repo" name="repo" type="text" placeholder="https://github.com/owner/repo" autoComplete="off" spellCheck={false} maxLength={300} required />
              <button className="btn btn-primary btn-sm" type="submit">
                Analyze any repo
              </button>
            </form>
            <p className="muted hero-note">Paste any public GitHub URL. Or add the server to your agent: <a href="#connect">connect it</a>.</p>
          </div>

          <div className="box session hero-visual" role="group" aria-label={`Example tool calls on ${d.snapshot.repo}`}>
            <div className="box-header">
              <span className="window-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              Tool calls on {d.snapshot.repo}
              <span className="label label-success">real output</span>
            </div>
            <ol>
              <li>
                <Icon name="check" />
                <span className="tool">build_graph</span>
                <span className="out">
                  {d.snapshot.id}: tier {d.snapshot.tier}, {d.snapshot.files} files, {d.snapshot.mergedPrs} merged PRs
                </span>
              </li>
              <li>
                <Icon name="check" />
                <span className="tool">key_files</span>
                <span className="out">
                  Must read: {short(topKey.path)} ({topKey.score.toFixed(2)})
                </span>
              </li>
              <li>
                <Icon name="check" />
                <span className="tool">tour_next</span>
                <span className="out">
                  Stage {d.tour.progress}, {d.tour.name}, with a check question and a graph
                </span>
              </li>
              <li>
                <Icon name="check" />
                <span className="tool">find_candidate_issues</span>
                <span className="out">
                  {f.passed} of {f.considered} open issues kept
                </span>
              </li>
              <li>
                <Icon name="check" />
                <span className="tool">localize_issue</span>
                <span className="out">
                  #{best.number} → {short(topLocal.path)} ({topLocal.score.toFixed(2)})
                </span>
              </li>
              <li>
                <Icon name="check" />
                <span className="tool">score_first_change</span>
                <span className="out">Fit {d.firstChange.score.toFixed(2)} out of 1</span>
              </li>
            </ol>
            <div className="session-foot">Generated from the shipped snapshot. Nothing here is mocked.</div>
          </div>
        </div>
      </section>

      <div className="container">
        <div className="box stats" style={{ marginTop: 32 }} role="group" aria-label="Key numbers">
          <div className="stat">
            <b>{d.tools.length}</b>
            <span>MCP tools, one job each</span>
          </div>
          <div className="stat">
            <b>{pct(a.hit5)}</b>
            <span>top-5 file hit rate on {a.prs} real PRs</span>
          </div>
          <div className="stat">
            <b>Any</b>
            <span>public GitHub repo, built from its URL</span>
          </div>
          <div className="stat">
            <b>{a.byRepo.length}</b>
            <span>repos precomputed, in 3 languages</span>
          </div>
        </div>

        <section className="section" aria-labelledby="ba">
          <div className="section-head">
            <span className="eyebrow">The problem</span>
            <h2 id="ba">Before and after</h2>
            <p>
              The same repo, <strong>{d.snapshot.repo}</strong> ({d.snapshot.files} files, {d.snapshot.mergedPrs} merged pull requests read).
            </p>
          </div>
          <div className="box">
            <div className="box-header">
              <Icon name="file" size={16} />
              {repoShort}
              <span className="muted">first day on the project</span>
            </div>
            <div className="diff" role="group" aria-label="Before is shown in red, after in green">
              <div className="diff-line del">
                <span className="diff-sign" aria-label="before">
                  −
                </span>
                <span>
                  <strong>{f.considered} open issues</strong> and a flat file tree
                </span>
              </div>
              <div className="diff-line del">
                <span className="diff-sign" aria-label="before">
                  −
                </span>
                <span>A README that may be stale, with nothing saying which files matter</span>
              </div>
              <div className="diff-line del">
                <span className="diff-sign" aria-label="before">
                  −
                </span>
                <span>No sign of which issues are already taken, or who to ask</span>
              </div>
              <div className="diff-gap">With RepoAtlas</div>
              <div className="diff-line add">
                <span className="diff-sign" aria-label="after">
                  +
                </span>
                <span>
                  <strong>{f.passed} issues you can start</strong>, each with the likely files and a fit score for you
                </span>
              </div>
              <div className="diff-line add">
                <span className="diff-sign" aria-label="after">
                  +
                </span>
                <span>A guided tour with the key files highlighted and the reason for each</span>
              </div>
              <div className="diff-line add">
                <span className="diff-sign" aria-label="after">
                  +
                </span>
                <span>
                  {f.excluded.stale} issues dropped as stale, {f.excluded.blocked} as blocked, {f.excluded.claimed} as claimed, with the evidence
                </span>
              </div>
            </div>
          </div>
        </section>

        <section id="how" className="section" aria-labelledby="how-h">
          <div className="section-head">
            <span className="eyebrow">How it works</span>
            <h2 id="how-h">You talk to your agent. It calls the tools.</h2>
            <p>Every answer carries its evidence, and nothing is ranked by a model: each ranking is a formula over the graph.</p>
          </div>
          <ol className="timeline">
            {STEPS.map((s) => (
              <li key={s.title}>
                <span className="badge-icon">
                  <Icon name={s.icon} size={18} />
                </span>
                <h3>{s.title}</h3>
                <p>{s.text}</p>
                <div className="tools">
                  {s.tools.map((t) => (
                    <code key={t}>{t}</code>
                  ))}
                </div>
              </li>
            ))}
          </ol>
          <p className="muted" style={{ marginTop: 24, textAlign: 'center' }}>
            Try asking: <em>“Walk me through {d.snapshot.repo}. I’m a TypeScript dev with about a year of experience.”</em>
          </p>
        </section>

        <section id="tools" className="section" aria-labelledby="tools-h">
          <div className="section-head">
            <span className="eyebrow">The toolbox</span>
            <h2 id="tools-h">Twelve tools, one job each</h2>
            <p>
              Plus a resource (<code>graph://{'{repo}'}@{'{sha}'}/summary</code>) and a prompt (<code>guide_me</code>). Run any of them in the <a href="/tools/">tool explorer</a>.
            </p>
          </div>
          <div className="box tablewrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Tool</th>
                  <th scope="col">Part</th>
                  <th scope="col">What it returns</th>
                </tr>
              </thead>
              <tbody>
                {TOOLS.map((t) => (
                  <tr key={t.name}>
                    <td>
                      <code>{t.name}</code>
                    </td>
                    <td>
                      <span className={`label ${t.tone}`}>{t.group}</span>
                    </td>
                    <td>{t.text}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="section" aria-labelledby="real">
          <div className="section-head">
            <span className="eyebrow">Real output</span>
            <h2 id="real">What an agent actually receives</h2>
            <p>
              From the snapshot <code>{d.snapshot.id}</code> (tier {d.snapshot.tier}, built {day(d.snapshot.asOf)}). Generated from the shipped data, not mocked.
            </p>
          </div>

          <div className="box">
            <div className="box-header">
              <Icon name="file" size={16} />
              <code>key_files</code>
              <span className="muted">where to start reading</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col" className="num">
                      Score
                    </th>
                    <th scope="col">Why</th>
                  </tr>
                </thead>
                <tbody>
                  {d.keyFiles.map((k) => (
                    <tr key={k.path}>
                      <td>
                        <code>{short(k.path)}</code>
                      </td>
                      <td className="num">{k.score.toFixed(2)}</td>
                      <td>{k.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid2" style={{ marginTop: 16 }}>
            <div className="box">
              <div className="box-header">
                <Icon name="route" size={16} />
                <code>tour_next</code>
                <span className="muted">
                  stage {d.tour.progress}, {d.tour.name}
                </span>
              </div>
              <div className="box-body">
                <p>The most-imported files: {d.tour.coreModules.map((m) => `${m.path.split('/').slice(-2).join('/')} (${m.fanIn} importers)`).join(', ')}.</p>
                <div className="callout">
                  <Icon name="alert" />
                  <div>
                    <strong>Check question.</strong> {d.tour.question}
                  </div>
                </div>
              </div>
            </div>

            <div className="box">
              <div className="box-header">
                <Icon name="issue" size={16} />
                <code>score_first_change</code>
                <span className="muted">for a beginner TypeScript profile</span>
              </div>
              <div className="box-body">
                <p style={{ marginBottom: 4 }}>
                  <a href={best.url}>
                    #{best.number} {best.title}
                  </a>
                </p>
                <div className="chips" aria-label="score factors">
                  {d.firstChange.factors.map((x) => (
                    <span className="chip" key={x.name}>
                      {x.name} {x.floored}
                    </span>
                  ))}
                </div>
                <p>
                  Overall fit <strong>{d.firstChange.score.toFixed(2)}</strong> out of 1, about <strong>{best.filesToChange} files</strong>. {d.firstChange.effort}
                </p>
              </div>
            </div>
          </div>

          <div className="box" style={{ marginTop: 16 }}>
            <div className="box-header">
              <Icon name="target" size={16} />
              <code>localize_issue</code>
              <span className="muted">the files that issue would change</span>
              <span className="label">confidence: {d.localize.confidence}</span>
            </div>
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">File</th>
                    <th scope="col" className="num">
                      Score
                    </th>
                    <th scope="col">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {d.localize.files.map((x) => (
                    <tr key={x.path}>
                      <td>
                        <code>{short(x.path)}</code>
                      </td>
                      <td className="num">{x.score.toFixed(2)}</td>
                      <td>{x.evidence}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="session-foot">Issue text from GitHub is treated as data and never as instructions.</div>
          </div>
        </section>

        <section className="section" aria-labelledby="graph">
          <div className="section-head">
            <span className="eyebrow">Widget</span>
            <h2 id="graph">The graph widget</h2>
            <p>
              <code>tour_next</code> and <code>explain_file</code> return a small subgraph that the widget draws. The same drawing is live in the <a href="/tools/">tool explorer</a>, where you can click any file.
            </p>
          </div>
          <div className="box">
            <div className="box-body">
              <figure className="figure">
                <img src="/screens/tour-stage-4.svg" alt={`Import graph for ${repoShort}, stage ${d.tour.progress} ${d.tour.name}: the highlighted files and the files that import them`} width={450} height={446} />
                <figcaption>
                  Rendered from the real <code>tour_next</code> result with the widget’s own layout code: at most 25 files, the current stop highlighted. It only draws what the tool returns.
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section id="accuracy" className="section" aria-labelledby="acc">
          <div className="section-head">
            <span className="eyebrow">Evidence</span>
            <h2 id="acc">How accurate is it?</h2>
            <p>
              Given only an issue’s text, the file the real fix changed was in the top 5 for <strong>{pct(a.hit5)}</strong> of {a.prs} merged pull requests across three repos.
            </p>
          </div>
          <div className="grid2">
            <div className="box">
              <div className="box-header">Top-5 hit rate</div>
              <div className="box-body">
                <div className="bars">
                  <div className="bar-row">
                    <div className="bar-top">
                      <span>RepoAtlas</span>
                      <b>{pct(a.hit5)}</b>
                    </div>
                    <div className="progress" aria-hidden="true">
                      <span style={{ width: pct(a.hit5) }} />
                    </div>
                  </div>
                  <div className="bar-row">
                    <div className="bar-top">
                      <span>5 most-imported files</span>
                      <b>{pct(a.fanIn)}</b>
                    </div>
                    <div className="progress" aria-hidden="true">
                      <span className="grey" style={{ width: pct(a.fanIn) }} />
                    </div>
                  </div>
                  <div className="bar-row">
                    <div className="bar-top">
                      <span>5 random files</span>
                      <b>{pct(a.random)}</b>
                    </div>
                    <div className="progress" aria-hidden="true">
                      <span className="grey" style={{ width: pct(a.random) }} />
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div className="box">
              <div className="box-header">By repo</div>
              <table>
                <thead>
                  <tr>
                    <th scope="col">Repo</th>
                    <th scope="col" className="num">
                      PRs tested
                    </th>
                    <th scope="col" className="num">
                      Top-5 hit rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {a.byRepo.map((r) => (
                    <tr key={r.repo}>
                      <td>{r.repo}</td>
                      <td className="num">{r.n}</td>
                      <td className="num">{pct(r.hit5)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="callout" style={{ marginTop: 16 }}>
            <Icon name="alert" />
            <div>
              <strong>Honest caveats.</strong> {a.prs} PRs is a small sample (the 95% range is roughly 56% to 81%); none of them were from first-time contributors; the file names it searches are from today’s code, so the
              true rate is probably a little lower. The Go repo has no import graph (tier 1) and scores lowest. These numbers are for the three precomputed repos, built with a full compiler-based parse and
              file-level history. Repos built on demand use a lighter import scan and, unless the server has a GitHub token, no per-commit file history, so expect lower accuracy there; that has not been measured. Full method and the numbers that could not be measured are in{' '}
              <a href={`${GITHUB}/blob/main/docs/EVAL.md`}>docs/EVAL.md</a>.
            </div>
          </div>
        </section>

        <section id="connect" className="section" aria-labelledby="conn">
          <div className="section-head">
            <span className="eyebrow">Get started</span>
            <h2 id="conn">Connect it to your agent</h2>
            <p>
              RepoAtlas is a standard remote MCP server. No login or key is needed to call it. Or skip setup and <a href="/demo/">run the whole tool chain in your browser</a>.
            </p>
          </div>
          <div className="box">
            <div className="box-header">
              <Icon name="fork" size={16} />
              MCP endpoint
            </div>
            <div className="box-body">
              <p className="codelabel">Claude, ChatGPT and other clients with custom connectors</p>
              <CodeBlock text={MCP_URL} label="MCP endpoint URL" />
              <p className="codelabel">Clients that only run local servers (for example Claude Desktop), through the mcp-remote bridge</p>
              <CodeBlock text={MCP_REMOTE} label="Client configuration" />
              <p className="muted" style={{ marginTop: 12, marginBottom: 0 }}>
                Step-by-step for adding a remote MCP server to Claude and ChatGPT: <a href={GUIDE}>this guide</a>. You can also open the app in NitroChat on NitroCloud.
              </p>
            </div>
          </div>
        </section>

        <section className="section" aria-labelledby="limits">
          <div className="section-head">
            <span className="eyebrow">Know the edges</span>
            <h2 id="limits">Limits and safety</h2>
          </div>
          <div className="grid4">
            {FEATURES.map((x) => (
              <div className="box feature" key={x.title}>
                <div className="box-body">
                  <h3>
                    <Icon name={x.icon} />
                    {x.title}
                  </h3>
                  <p>{x.text}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 16 }}>
            Instant (precomputed): {a.byRepo.map((r) => r.repo).join(', ')}, as of {day(d.snapshot.asOf)}. Everything else is built when you ask. <CopyButton text={MCP_URL} label="Copy endpoint" />
          </p>
        </section>
      </div>
    </main>
  );
}
