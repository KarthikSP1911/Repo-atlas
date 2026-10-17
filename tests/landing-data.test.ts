import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { findCandidates } from '../src/services/candidates.service.js';
import { StoreService } from '../src/services/store.service.js';

/**
 * The landing page (web/) shows numbers and examples from web/data/example.json. These tests fail
 * if that file goes stale against the evaluation results, the shipped snapshots or the tool list;
 * regenerate with `npm run landing:data`.
 */
const example = JSON.parse(fs.readFileSync('web/data/example.json', 'utf8'));
const backtest = JSON.parse(fs.readFileSync('docs/eval/backtest.json', 'utf8'));

describe('landing page data', () => {
  it('shows the same accuracy numbers as docs/eval/backtest.json', () => {
    expect(example.accuracy.prs).toBe(backtest.total);
    expect(example.accuracy.hit5).toBeCloseTo(backtest.byVariant['default weights'].hit5, 6);
    expect(example.accuracy.random).toBeCloseTo(backtest.byVariant['baseline: random 5 files'].hit5, 6);
    expect(example.accuracy.fanIn).toBeCloseTo(backtest.byVariant['baseline: top 5 by fan-in'].hit5, 6);
    expect(example.accuracy.byRepo.map((r: { repo: string; n: number }) => `${r.repo}:${r.n}`).sort()).toEqual(
      Object.entries(backtest.byRepo as Record<string, { n: number }>).map(([repo, v]) => `${repo}:${v.n}`).sort(),
    );
  });

  it('lists exactly the 12 tools', () => {
    expect([...example.tools].sort()).toEqual(
      ['build_graph', 'project_overview', 'find_entry_points', 'key_files', 'trace_flow', 'explain_file', 'tour_next', 'profile_contributor', 'find_candidate_issues', 'localize_issue', 'score_first_change', 'export_guide'].sort(),
    );
  });

  it('matches the shipped snapshot and its issue filters', async () => {
    const store = new StoreService();
    store.dir = 'data/snapshots';
    const snap = await store.load(example.snapshot.id);
    expect(snap.repo).toBe(example.snapshot.repo);
    expect(snap.builtAt).toBe(example.snapshot.asOf);
    const issues = (await store.loadIssues(example.snapshot.id))!;
    const r = findCandidates(issues, example.profile, 100);
    expect(r.considered).toBe(example.candidateFilters.considered);
    expect(r.candidates.length).toBe(example.candidateFilters.passed);
    expect(r.excluded).toEqual(example.candidateFilters.excluded);
  });

  it('features a real shortlisted issue, and the example score matches the first candidate shown', () => {
    expect(example.candidates[0].number).toBe(example.firstChange.issue);
    expect(example.candidates[0].number).toBe(example.localize.issue);
    expect(example.candidates[0].url).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/);
    expect(example.candidates[0].firstChangeScore).toBeCloseTo(example.firstChange.score, 6);
    const scores = example.candidates.map((c: { firstChangeScore: number }) => c.firstChangeScore);
    expect(scores).toEqual([...scores].sort((a: number, b: number) => b - a));
  });

  it('contains no email addresses, no individuals\' names for "who to ask", and no tokens', () => {
    const text = fs.readFileSync('web/data/example.json', 'utf8');
    expect(text).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(text).not.toMatch(/github_pat_|ghp_[A-Za-z0-9]{20}/);
    expect(text).not.toContain('whoToAsk');
  });

  it('has the rendered graph picture with an accessible label', () => {
    const svg = fs.readFileSync('web/public/screens/tour-stage-4.svg', 'utf8');
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('aria-label="4 of 8: Core modules"');
    expect(svg).not.toMatch(/<script|onload=|javascript:/i);
  });
});
