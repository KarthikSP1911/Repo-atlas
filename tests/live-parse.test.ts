import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { jsSpecifiers, jsSymbols, parseContentsLight } from '../src/services/live/parse-light.js';
import { parseContents } from '../src/services/parse.service.js';

describe('jsSpecifiers', () => {
  it('finds every kind of import', () => {
    const src = `
import a from './a';
import { b, c as d } from "./b";
import type { T } from './types';
import * as ns from './ns';
import def, { x } from './mixed';
import './side-effect';
import {
  multi,
  line,
} from './multi';
export * from './re-all';
export { r1, r2 } from './re-some';
export type { RT } from './re-type';
const req = require('./req');
const lazy = await import('./lazy');
`;
    expect(jsSpecifiers(src).sort()).toEqual(['./a', './b', './lazy', './mixed', './multi', './ns', './re-all', './re-some', './re-type', './req', './side-effect', './types'].sort());
  });

  it('ignores comments and ordinary strings', () => {
    const src = `
// import nothing from './line-comment';
/* import nothing from './block-comment'; */
/**
 * Example: import x from './in-doc';
 */
export const label = 'import something from';
export const path = "./not-an-import";
const text = \`require('./in-template')\`;
`;
    const found = jsSpecifiers(src);
    expect(found).not.toContain('./line-comment');
    expect(found).not.toContain('./block-comment');
    expect(found).not.toContain('./in-doc');
    expect(found).not.toContain('./not-an-import');
  });
});

describe('jsSymbols', () => {
  it('lists exported and local names', () => {
    const r = jsSymbols(`
export function run() {}
export async function go() {}
export default class App {}
export const A = 1, B = 2;
export interface Opts {}
export type Id = string;
export enum Kind {}
export { local as renamed, other };
function helper() {}
const internal = () => 1;
class Hidden {}
`);
    expect(r.exports).toEqual(expect.arrayContaining(['run', 'go', 'App', 'A', 'Opts', 'Id', 'Kind', 'renamed', 'other']));
    expect(r.symbols).toEqual(expect.arrayContaining(['helper', 'internal', 'Hidden']));
    expect(r.exports).not.toContain('helper');
  });

  it('recognises a default export of an expression', () => {
    expect(jsSymbols('const x = 1;\nexport default x;\n').exports).toContain('default');
  });
});

describe('parseContentsLight', () => {
  const files: Record<string, string> = {
    'src/index.ts': "import { a } from './a';\nimport b from './dir';\nimport '@/lib/util';\nimport '~/other';\nimport '@acme/core';\napp.listen(1);\n",
    'src/a.ts': "export const a = 1;\nimport('./dir/index.js');\n",
    'src/dir/index.ts': 'export default 1;\n',
    'src/lib/util.ts': 'export {};\n',
    'src/other.ts': 'export {};\n',
    'packages/core/package.json': JSON.stringify({ name: '@acme/core', main: 'dist/index.js' }),
    'packages/core/src/index.ts': 'export const core = 1;\n',
    'py/app/__init__.py': '',
    'py/app/main.py': '"""Main module."""\nfrom . import util\nfrom .util import helper\nimport app.other\nif __name__ == "__main__":\n    pass\n',
    'py/app/util.py': 'def helper():\n    pass\n',
    'py/app/other.py': 'class Thing: pass\n',
    'main.go': 'package main\nfunc main() {}\n',
  };
  const paths = new Set(Object.keys(files));
  const res = parseContentsLight(paths, new Map(Object.entries(files)), new Map([['LICENSE', 12]]));

  it('resolves relative imports, directory indexes, .js to .ts, aliases and workspace packages', () => {
    expect(res.files.get('src/index.ts')!.imports.map((i) => i.to)).toEqual(['packages/core/src/index.ts', 'src/a.ts', 'src/dir/index.ts', 'src/lib/util.ts', 'src/other.ts']);
    expect(res.files.get('src/a.ts')!.imports.map((i) => i.to)).toEqual(['src/dir/index.ts']);
  });

  it('resolves a workspace package name to its source entry', () => {
    const more = { ...files, 'packages/core/src/index.ts': 'export const core = 1;\n', 'app/x.ts': "import { core } from '@acme/core';\n" };
    const r = parseContentsLight(new Set(Object.keys(more)), new Map(Object.entries(more)));
    expect(r.files.get('app/x.ts')!.imports.map((i) => i.to)).toEqual(['packages/core/src/index.ts']);
  });

  it('handles Python relative and absolute imports, the main guard and the docstring', () => {
    const main = res.files.get('py/app/main.py')!;
    expect(main.imports.map((i) => i.to).sort()).toEqual(['py/app/other.py', 'py/app/util.py']);
    expect(main.signals.mainGuard).toBe(true);
    expect(main.doc).toBe('Main module.');
  });

  it('sets signals, tier and stats', () => {
    expect(res.files.get('src/index.ts')!.signals.listen).toBe(true);
    expect(res.files.get('main.go')!.signals.goMain).toBe(true);
    expect(res.tier).toBe(2);
    expect(res.stats.jsTsFiles).toBe(6);
    expect(res.stats.pyFiles).toBe(4);
  });

  it('is tier 1 without JS, TS or Python, and uses supplied line counts for files whose text was not kept', () => {
    const r = parseContentsLight(new Set(['main.go', 'LICENSE']), new Map([['main.go', 'package main\n']]), new Map([['LICENSE', 12]]));
    expect(r.tier).toBe(1);
    expect(r.files.get('LICENSE')!.loc).toBe(12);
    expect(r.files.get('main.go')!.loc).toBe(1);
  });

  it('never throws on hostile or broken input', () => {
    const junk = new Map([
      ['a.ts', "import {{{ from '"],
      ['b.ts', "import x from '" + 'a'.repeat(50_000)],
      ['c.py', 'from import import\n\x00\x01'],
      ['d.js', "require('".repeat(1000)],
      ['tsconfig.json', '{ not json'],
      ['package.json', '[1,2'],
    ]);
    expect(() => parseContentsLight(new Set(junk.keys()), junk)).not.toThrow();
  });

  it('stays fast on a pathological file', () => {
    const big = `import {${'a,'.repeat(100_000)}} from './x';\n${' '.repeat(200_000)}`;
    const t0 = Date.now();
    parseContentsLight(new Set(['big.ts', 'x.ts']), new Map([['big.ts', big.slice(0, 390_000)], ['x.ts', '']]));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('agreement with the compiler-based parser (this repository as the sample)', () => {
  const tracked = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) return e.name === 'node_modules' || e.name === '.next' || e.name === 'out' ? [] : tracked(p);
      return /\.(ts|tsx)$/.test(e.name) || e.name === 'tsconfig.json' ? [p] : [];
    });

  it('finds at least 97% of the import edges ts-morph finds, and invents almost none', () => {
    const paths = [...tracked('src'), ...tracked('scripts'), ...tracked('tests'), 'tsconfig.json'];
    const contents = new Map(paths.map((p) => [p, fs.readFileSync(p, 'utf8')]));
    const all = new Set(paths);
    const exact = parseContents(all, contents);
    const light = parseContentsLight(all, contents);
    const edges = (r: typeof exact): Set<string> => new Set([...r.files.values()].flatMap((f) => f.imports.map((i) => `${f.path}>${i.to}`)));
    const e = edges(exact);
    const l = edges(light);
    const found = [...e].filter((x) => l.has(x)).length;
    const extra = [...l].filter((x) => !e.has(x)).length;
    expect(e.size).toBeGreaterThan(150);
    expect(found / e.size).toBeGreaterThanOrEqual(0.97);
    expect(extra / e.size).toBeLessThanOrEqual(0.02);
  }, 90_000);
});
