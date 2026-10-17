import { GITHUB, GUIDE } from '../lib/config';
import { Logo } from './Logo';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <div className="footer-grid">
          <div>
            <span className="footer-brand">
              <Logo size={24} />
              RepoAtlas
            </span>
            <p>An MCP server that turns a GitHub repo into a graph of code, history, people and issues, so an agent can guide a newcomer.</p>
          </div>
          <div>
            <h3>Product</h3>
            <ul>
              <li>
                <a href="/demo/">Live demo</a>
              </li>
              <li>
                <a href="/tools/">Tool explorer</a>
              </li>
              <li>
                <a href="/#how">How it works</a>
              </li>
              <li>
                <a href="/#accuracy">Accuracy</a>
              </li>
            </ul>
          </div>
          <div>
            <h3>Resources</h3>
            <ul>
              <li>
                <a href={GITHUB}>Source on GitHub</a>
              </li>
              <li>
                <a href={`${GITHUB}/blob/main/docs/EVAL.md`}>Evaluation method</a>
              </li>
              <li>
                <a href={`${GITHUB}/blob/main/docs/DECISIONS.md`}>Design decisions</a>
              </li>
              <li>
                <a href="/#connect">Connect to an agent</a>
              </li>
            </ul>
          </div>
          <div>
            <h3>Built with</h3>
            <ul>
              <li>
                <a href="https://docs.nitrostack.ai">NitroStack</a>
              </li>
              <li>NitroCloud free tier</li>
              <li>
                <a href={GUIDE}>MCP in Claude and ChatGPT</a>
              </li>
            </ul>
          </div>
        </div>
        <p className="footer-fine">RepoAtlas is an independent project and is not affiliated with GitHub. Built for the NitroStack MCP buildathon. Results are as of each snapshot&rsquo;s build date.</p>
      </div>
    </footer>
  );
}
