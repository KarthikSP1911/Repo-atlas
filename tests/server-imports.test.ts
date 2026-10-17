import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The deployed server installs only `dependencies`. Everything reachable from the app module
 * must therefore avoid the offline-only packages (git client, TypeScript compiler, Octokit, test
 * tools). This walks the import graph from src/app.module.ts and fails if one sneaks in, which
 * would crash the server at startup on NitroCloud while every unit test still passed.
 */
const OFFLINE_ONLY = ['simple-git', 'ts-morph', 'typescript', '@octokit/graphql', 'tsx', 'vitest'];

function reachable(entry: string): { files: Set<string>; bare: Map<string, string> } {
  const files = new Set<string>();
  const bare = new Map<string, string>();
  const todo = [entry];
  while (todo.length) {
    const file = todo.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    // runtime imports only: `import type` and `export type` are erased by the compiler
    const re = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(re)) {
      const spec = m[1];
      if (spec.startsWith('.')) {
        const target = path.resolve(path.dirname(file), spec.replace(/\.js$/, '.ts'));
        if (fs.existsSync(target)) todo.push(target);
      } else if (!spec.startsWith('node:')) {
        const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        if (!bare.has(pkg)) bare.set(pkg, path.relative(process.cwd(), file));
      }
    }
  }
  return { files, bare };
}

describe('what the deployed server loads', () => {
  const { files, bare } = reachable(path.resolve('src/app.module.ts'));

  it('walks a realistic part of the source tree', () => {
    expect(files.size).toBeGreaterThan(30);
    expect(bare.has('graphology-metrics')).toBe(true); // proves the scan sees real imports
    expect([...files].some((f) => f.endsWith(path.join('live', 'build-live.ts')))).toBe(true);
    expect([...files].some((f) => f.endsWith(path.join('services', 'graph.service.ts')))).toBe(true);
  });

  it('never imports an offline-only package', () => {
    const bad = OFFLINE_ONLY.filter((p) => bare.has(p)).map((p) => `${p} (from ${bare.get(p)})`);
    expect(bad).toEqual([]);
  });

  it('only imports packages that are runtime dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
    const allowed = new Set(Object.keys(pkg.dependencies));
    const missing = [...bare.keys()].filter((p) => !allowed.has(p)).map((p) => `${p} (from ${bare.get(p)})`);
    expect(missing).toEqual([]);
  });
});
