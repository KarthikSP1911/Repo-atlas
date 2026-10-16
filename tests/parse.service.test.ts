import { describe, expect, it } from 'vitest';
import { langOf, parseContents, pyImportsOf } from '../src/services/parse.service.js';

function parse(files: Record<string, string>) {
  const contents = new Map(Object.entries(files));
  return parseContents(new Set(contents.keys()), contents);
}
const importsOf = (r: ReturnType<typeof parse>, p: string): string[] => r.files.get(p)!.imports.map((i) => i.to);

describe('JS/TS imports', () => {
  const repo = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/index.ts': [
      "import { a } from './a.js';",
      "import b from '@/b';",
      "import 'node:fs';",
      "import React from 'react';",
      "export * from './c';",
      "export { z } from './z';",
      "import type { T } from './types';",
      "const d = await import('./d');",
      "const e = require('./e');",
      "import { a2 } from './a.js';",
    ].join('\n'),
    'src/a.ts': 'export const a = 1;',
    'src/b.ts': 'export default 1;',
    'src/c/index.ts': 'export const c = 1;',
    'src/d.tsx': 'export const d = 1;',
    'src/e.js': 'module.exports = 1;',
    'src/z.ts': 'export const z = 1;',
    'src/types.ts': 'export type T = number;',
  };

  it('resolves relative, .js->.ts, tsconfig paths, index files, re-exports, dynamic import and require', () => {
    const r = parse(repo);
    expect(importsOf(r, 'src/index.ts')).toEqual(['src/a.ts', 'src/b.ts', 'src/c/index.ts', 'src/d.tsx', 'src/e.js', 'src/types.ts', 'src/z.ts']);
    expect(r.files.get('src/index.ts')!.imports.find((i) => i.to === 'src/a.ts')!.weight).toBe(2);
    expect(r.tier).toBe(2);
  });

  it('ignores bare packages, node: builtins and unresolved paths', () => {
    const r = parse({ 'a.ts': "import fs from 'node:fs'; import x from 'lodash'; import y from './missing';" });
    expect(importsOf(r, 'a.ts')).toEqual([]);
  });

  it('extracts exports, top-level symbols, doc and signals', () => {
    const r = parse({
      'src/server.ts': [
        '#!/usr/bin/env node',
        '/** Starts the HTTP server and wires routes. */',
        'export function start() {}',
        'export class Server {}',
        'export interface Opts {}',
        'export const PORT = 3000;',
        'function helper() {}',
        'function internal() {}',
        'const { x, y } = obj;',
        'export { helper as publicHelper };',
        'export default start;',
        'app.listen(3000);',
      ].join('\n'),
    });
    const f = r.files.get('src/server.ts')!;
    expect(f.exports).toEqual(expect.arrayContaining(['start', 'Server', 'Opts', 'PORT', 'publicHelper', 'default']));
    expect(f.symbols).toEqual(['internal']);
    expect(f.exports).toContain('helper'); // exported under an alias counts as exported
    expect(f.doc).toBe('Starts the HTTP server and wires routes.');
    expect(f.signals).toMatchObject({ shebang: true, listen: true });
    expect(f.loc).toBe(12);
  });

  it('skips license headers when picking a doc line', () => {
    const r = parse({ 'a.ts': '/* Copyright (c) Someone. MIT License */\nexport const a = 1;' });
    expect(r.files.get('a.ts')!.doc).toBeUndefined();
  });

  it('resolves workspace packages by name, main (dist->src) and subpath', () => {
    const r = parse({
      'packages/core/package.json': JSON.stringify({ name: '@acme/core', main: 'dist/index.js' }),
      'packages/core/src/index.ts': 'export const core = 1;',
      'packages/core/src/util.ts': 'export const util = 1;',
      'packages/app/src/main.ts': "import { core } from '@acme/core'; import { util } from '@acme/core/util';",
    });
    expect(importsOf(r, 'packages/app/src/main.ts')).toEqual(['packages/core/src/index.ts', 'packages/core/src/util.ts']);
  });

  it('uses the nearest tsconfig for path aliases', () => {
    const r = parse({
      'web/tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '~/*': ['app/*'] } } }),
      'web/app/x.ts': 'export const x = 1;',
      'web/page.ts': "import { x } from '~/x';",
      'other/page.ts': "import { x } from '~/x';",
    });
    expect(importsOf(r, 'web/page.ts')).toEqual(['web/app/x.ts']);
    expect(importsOf(r, 'other/page.ts')).toEqual([]);
  });

  it('survives syntax errors and keeps going', () => {
    const r = parse({ 'bad.ts': 'import { from ;; export const = ', 'ok.ts': "import './bad';" });
    expect(importsOf(r, 'ok.ts')).toEqual(['bad.ts']);
  });
});

describe('Python imports', () => {
  const repo = new Set([
    'app.py', 'pkg/__init__.py', 'pkg/core.py', 'pkg/sub/__init__.py', 'pkg/sub/helper.py',
    'src/mylib/__init__.py', 'src/mylib/a.py', 'tests/test_a.py',
  ]);

  it.each([
    ['app.py', 'import pkg.core\nimport os, sys\nfrom pkg import sub\nfrom pkg.sub import helper as h', ['pkg/core.py', 'pkg/sub/__init__.py', 'pkg/sub/helper.py']],
    ['pkg/core.py', 'from .sub import helper\nfrom . import sub\nfrom .. import nothing', ['pkg/sub/__init__.py', 'pkg/sub/helper.py']],
    ['pkg/sub/helper.py', 'from .. import core\nfrom ..core import thing', ['pkg/core.py']],
    ['tests/test_a.py', 'from mylib.a import f\nimport mylib', ['src/mylib/__init__.py', 'src/mylib/a.py']],
    ['app.py', 'from pkg.sub import (\n    helper,\n    other,\n)', ['pkg/sub/__init__.py', 'pkg/sub/helper.py']],
    ['app.py', 'import requests\nfrom flask import Flask  # not in repo', []],
  ])('%s', (file, src, expected) => {
    expect(pyImportsOf(file, src, repo).map((i) => i.to)).toEqual(expected);
  });

  it('collects public names, signals and the module docstring', () => {
    const r = parse({
      'tool.py': '"""Command line tool for X.\n\nMore text."""\nimport sys\n\ndef main():\n    pass\n\ndef _private(): pass\n\nclass Runner: pass\n\nif __name__ == "__main__":\n    main()\n',
    });
    const f = r.files.get('tool.py')!;
    expect(f.exports).toEqual(['main', 'Runner']);
    expect(f.symbols).toEqual(['_private']);
    expect(f.doc).toBe('Command line tool for X.');
    expect(f.signals.mainGuard).toBe(true);
  });
});

describe('other languages and tiers', () => {
  it('gives Go and Rust only loc and language (tier 1)', () => {
    const r = parse({ 'main.go': 'package main\n\nfunc main() {}\n', 'src/lib.rs': 'pub fn a() {}\n' });
    expect(r.tier).toBe(1);
    expect(r.files.get('main.go')).toMatchObject({ lang: 'go', loc: 3 });
    expect(r.files.get('main.go')!.signals.goMain).toBe(true);
    expect(r.files.get('src/lib.rs')!.lang).toBe('rust');
  });

  it.each([['a/b.TSX', 'ts'], ['x.mjs', 'js'], ['Dockerfile', 'docker'], ['LICENSE', 'other'], ['a.weird', 'weird']])('langOf(%s)', (p, l) => {
    expect(langOf(p)).toBe(l);
  });
});
