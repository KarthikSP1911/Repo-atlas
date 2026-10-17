import { GLOSSARY } from '../lib/tool-specs';

/** "How to use this page" for someone who has never used an MCP server, plus a glossary. */
export function ToolGuide() {
  return (
    <section className="dm-card tx-guide" aria-labelledby="tx-guide-h">
      <h2 id="tx-guide-h">How to use this page</h2>
      <p className="tx-guide-lead">
        RepoAtlas is a set of 12 small tools that an AI assistant can call to understand a GitHub project. This page lets you try each one by hand and see exactly what the assistant would receive. No AI model is involved.
      </p>
      <ol className="tx-steps">
        <li>
          <span className="tx-step-n" aria-hidden="true">
            1
          </span>
          <div>
            <strong>Choose a repo</strong>
            <p>Use the Repo box at the top left. Pick a ready-made one, or choose &ldquo;Another GitHub repo&hellip;&rdquo; and paste any public GitHub link.</p>
          </div>
        </li>
        <li>
          <span className="tx-step-n" aria-hidden="true">
            2
          </span>
          <div>
            <strong>Pick a tool</strong>
            <p>The list is in a sensible order, from top to bottom. If you are new, start with Load a repository and use the &ldquo;Next step&rdquo; button after each result.</p>
          </div>
        </li>
        <li>
          <span className="tx-step-n" aria-hidden="true">
            3
          </span>
          <div>
            <strong>Read, fill in, run</strong>
            <p>Each tool explains what it does, what to type (with examples) and what you get back. Press Run tool, then read &ldquo;How to read this&rdquo; above the result.</p>
          </div>
        </li>
      </ol>
      <details className="tx-gloss">
        <summary>Words you will see</summary>
        <dl>
          {GLOSSARY.map((g) => (
            <div key={g.term} className="tx-ret">
              <dt>{g.term}</dt>
              <dd>{g.meaning}</dd>
            </div>
          ))}
        </dl>
      </details>
    </section>
  );
}
