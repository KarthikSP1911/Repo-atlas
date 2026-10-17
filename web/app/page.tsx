import data from '../data/example.json';

import { GITHUB, GUIDE, MCP_URL } from '../lib/config';

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const day = (iso: string): string => iso.slice(0, 10);
const short = (p: string): string => (p.length > 58 ? `…${p.slice(-57)}` : p);

export default function Home() {
  const d = data;
  const best = d.candidates[0];
  const f = d.candidateFilters;
  const a = d.accuracy;
  const repoShort = d.snapshot.repo.split('/')[1];

  return (
    <main>
      <header className="hero">
        <span className="badge">MCP server · built on NitroStack · Developer Tools</span>
        <h1>Open an unfamiliar repo. Know where to start.</h1>
        <p className="lede">
          RepoAtlas turns a GitHub repo into a graph of its code, history, people and issues. An AI agent uses it to walk you through the project one step at a time, then finds the
          issues you can actually finish, with the files to touch.
        </p>
        <div className="buttons">
          <a className="btn primary" href="/demo/">
            Try it live
          </a>
          <a className="btn" href="#connect">
            Connect it to your agent
          </a>
          <a className="btn" href={GITHUB}>
            View the code on GitHub
          </a>
        </div>
      </header>

      <section aria-labelledby="ba">
        <h2 id="ba">Before and after</h2>
        <p className="muted">
          The same repo, <strong>{d.snapshot.repo}</strong> ({d.snapshot.files} files, {d.snapshot.mergedPrs} merged pull requests read).
        </p>
        <div className="grid2">
          <div className="card before">
            <h3>Before</h3>
            <div className="big">{f.considered} open issues</div>
            <p>
              A flat file tree, a README that may be stale, and {f.considered} open issues. Nothing says which files matter, which issues are taken, or who to ask.
            </p>
          </div>
          <div className="card after">
            <h3>After, with RepoAtlas</h3>
            <div className="big">{f.passed} issues you can start</div>
            <p>
              A guided tour with the key files highlighted and the reason for each, then a shortlist: {f.excluded.stale} issues dropped as stale, {f.excluded.blocked} as blocked,{' '}
              {f.excluded.claimed} as claimed. Each one comes with the likely files and a fit score for you.
            </p>
          </div>
        </div>
      </section>

      <section aria-labelledby="how">
        <h2 id="how">How it works</h2>
        <p className="muted">You talk to your own AI agent. It calls RepoAtlas tools and explains what comes back; every answer carries its evidence.</p>
        <ol className="steps">
          <li>
            <span className="tool">Understand.</span> <code>build_graph</code>, <code>project_overview</code>, <code>find_entry_points</code>, <code>key_files</code>,{' '}
            <code>trace_flow</code>, <code>explain_file</code>. Where execution starts, what the project is for, and the files to read first, tiered Must read, Read next and Skip for now.
          </li>
          <li>
            <span className="tool">Tour.</span> <code>tour_next</code> walks 8 stages (orient, layout, entry points, core modules, config, tests, change patterns, people), adapted to your role, with a check
            question at each stop and a small graph drawn by a widget.
          </li>
          <li>
            <span className="tool">Match.</span> <code>profile_contributor</code> and <code>find_candidate_issues</code> keep only issues that are open, recent, clear and likely unclaimed, and show the evidence for
            each.
          </li>
          <li>
            <span className="tool">Localize and score.</span> <code>localize_issue</code> finds the files an issue would change; <code>score_first_change</code> shows how good a first change it is for you, factor by
            factor.
          </li>
          <li>
            <span className="tool">Export.</span> <code>export_guide</code> drafts an <code>ARCHITECTURE.md</code>. It returns a preview first and the full text only after you confirm. It never writes to your repo.
          </li>
        </ol>
        <p className="muted" style={{ marginTop: 12 }}>
          Try: <em>“Walk me through {d.snapshot.repo}. I’m a TypeScript dev with about a year of experience.”</em>
        </p>
      </section>

      <section aria-labelledby="real">
        <h2 id="real">Real output</h2>
        <p className="muted">
          From the snapshot <code>{d.snapshot.id}</code> (tier {d.snapshot.tier}, built {day(d.snapshot.asOf)}). Nothing here is mocked; it is generated from the shipped data.
        </p>

        <div className="card">
          <h3>
            <code>key_files</code>: where to start reading
          </h3>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Score</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {d.keyFiles.map((k) => (
                <tr key={k.path}>
                  <td>
                    <code>{short(k.path)}</code>
                  </td>
                  <td>{k.score.toFixed(2)}</td>
                  <td>{k.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid2" style={{ marginTop: 16 }}>
          <div className="card">
            <h3>
              <code>tour_next</code>: stage {d.tour.progress}, {d.tour.name}
            </h3>
            <p>
              The most-imported files: {d.tour.coreModules.map((m) => `${m.path.split('/').slice(-2).join('/')} (${m.fanIn} importers)`).join(', ')}.
            </p>
            <p className="note">
              <strong>Check question:</strong> {d.tour.question}
            </p>
          </div>

          <div className="card">
            <h3>
              <code>find_candidate_issues</code> → <code>score_first_change</code>
            </h3>
            <p className="muted">For a beginner TypeScript profile, the best fit among the shortlist:</p>
            <p>
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

        <div className="card" style={{ marginTop: 16 }}>
          <h3>
            <code>localize_issue</code>: the files that issue would change
          </h3>
          <table>
            <thead>
              <tr>
                <th>File</th>
                <th>Score</th>
                <th>Evidence</th>
              </tr>
            </thead>
            <tbody>
              {d.localize.files.map((x) => (
                <tr key={x.path}>
                  <td>
                    <code>{short(x.path)}</code>
                  </td>
                  <td>{x.score.toFixed(2)}</td>
                  <td>{x.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted" style={{ marginTop: 8 }}>
            Confidence: {d.localize.confidence}. Issue text from GitHub is treated as data and never as instructions.
          </p>
        </div>
      </section>

      <section aria-labelledby="graph">
        <h2 id="graph">The graph widget</h2>
        <figure className="figure">
          <img src="/screens/tour-stage-4.svg" alt={`Import graph for ${repoShort}, stage ${d.tour.progress} ${d.tour.name}: the highlighted files and the files that import them`} width={450} height={446} />
          <figcaption>
            The widget’s drawing of the stage above, rendered from the real <code>tour_next</code> result with the widget’s own layout code (at most 25 files; the current stop is highlighted, and clicking a file lights up
            its lines). It only draws what the tool returns.
          </figcaption>
        </figure>
      </section>

      <section aria-labelledby="acc">
        <h2 id="acc">How accurate is it?</h2>
        <p>
          Given only an issue’s text, the file the real fix changed was in the top 5 for <strong>{pct(a.hit5)}</strong> of {a.prs} merged pull requests across three repos. Picking 5 files at random would hit{' '}
          {pct(a.random)} of the time, and picking the 5 most-imported files {pct(a.fanIn)}.
        </p>
        <div aria-hidden="true">
          <div className="muted">RepoAtlas {pct(a.hit5)}</div>
          <div className="bar">
            <span style={{ width: pct(a.hit5) }} />
          </div>
          <div className="muted">5 most-imported files {pct(a.fanIn)}</div>
          <div className="bar">
            <span style={{ width: pct(a.fanIn), background: 'var(--muted)' }} />
          </div>
          <div className="muted">5 random files {pct(a.random)}</div>
          <div className="bar">
            <span style={{ width: pct(a.random), background: 'var(--muted)' }} />
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Repo</th>
              <th>PRs tested</th>
              <th>Top-5 hit rate</th>
            </tr>
          </thead>
          <tbody>
            {a.byRepo.map((r) => (
              <tr key={r.repo}>
                <td>{r.repo}</td>
                <td>{r.n}</td>
                <td>{pct(r.hit5)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          Honest caveats: {a.prs} PRs is a small sample (the 95% range is roughly 56% to 81%); none of them were from first-time contributors; the file names it searches are from today’s code, so the true rate is probably
          a little lower. The Go repo has no import graph (tier 1) and scores lowest. Full method and the numbers that could not be measured are in{' '}
          <a href={`${GITHUB}/blob/main/docs/EVAL.md`}>docs/EVAL.md</a>.
        </p>
      </section>

      <section id="connect" aria-labelledby="conn">
        <h2 id="conn">Connect it</h2>
        <p>
          Want to see it without setting anything up? <a href="/demo/">Run the whole tool chain live in your browser</a>: it calls the real server and shows exactly what an agent receives. RepoAtlas is a standard remote
          MCP server, so you can also add this URL as a custom MCP connector in Claude or ChatGPT, or open the app in NitroChat on NitroCloud.
        </p>
        <code className="endpoint" aria-label="MCP endpoint URL">
          {MCP_URL}
        </code>
        <p className="muted" style={{ marginTop: 10 }}>
          Step-by-step for adding a remote MCP server to Claude and ChatGPT: <a href={GUIDE}>this guide</a>. No login or key is needed to call it.
        </p>
      </section>

      <section aria-labelledby="limits">
        <h2 id="limits">Limits and safety</h2>
        <ul>
          <li>
            <strong>Precomputed repos only.</strong> The hosting platform has no <code>git</code>, so RepoAtlas serves snapshots built ahead of time: {a.byRepo.map((r) => r.repo).join(', ')}. Asking for another repo returns a
            clear message listing what is available.
          </li>
          <li>
            <strong>Tiers.</strong> JavaScript, TypeScript and Python get an import graph; every other language gets the file tree, history and people only, and says so.
          </li>
          <li>
            <strong>As of a date.</strong> Every answer states the snapshot’s commit and build date, and “likely unclaimed” is evidence, not a guarantee.
          </li>
          <li>
            <strong>Safe by design.</strong> The one action, <code>export_guide</code>, returns text only and needs a confirmation token. Text from repos and issues is treated as untrusted data. The server holds no GitHub token and
            makes no GitHub calls while you use it.
          </li>
        </ul>
      </section>

      <footer>
        RepoAtlas · MCP tools: {d.tools.length} · <a href={GITHUB}>Source on GitHub</a> · Built with NitroStack for the MCP buildathon. Data as of {day(d.snapshot.asOf)}.
      </footer>
    </main>
  );
}
