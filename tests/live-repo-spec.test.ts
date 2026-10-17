import { describe, expect, it } from 'vitest';
import { parseRepoSpec } from '../src/services/live/repo-spec.js';

describe('parseRepoSpec', () => {
  it.each([
    ['owner/repo', 'owner/repo'],
    ['  facebook/react  ', 'facebook/react'],
    ['lukeautry__tsoa', 'lukeautry/tsoa'],
    ['https://github.com/vercel/next.js', 'vercel/next.js'],
    ['http://github.com/vercel/next.js/', 'vercel/next.js'],
    ['https://www.github.com/a-b/c_d.e', 'a-b/c_d.e'],
    ['github.com/pallets/flask', 'pallets/flask'],
    ['https://github.com/pallets/flask.git', 'pallets/flask'],
    ['https://github.com/pallets/flask/tree/main/src/flask?plain=1#L10', 'pallets/flask'],
    ['https://github.com/pallets/flask/issues/123', 'pallets/flask'],
    ['git@github.com:rust-lang/rust.git', 'rust-lang/rust'],
    ['ssh://git@github.com/rust-lang/rust', 'rust-lang/rust'],
  ])('reads %s', (input, repo) => {
    expect(parseRepoSpec(input)?.repo).toBe(repo);
  });

  it('splits owner and name', () => {
    expect(parseRepoSpec('https://github.com/sindresorhus/is')).toEqual({ owner: 'sindresorhus', name: 'is', repo: 'sindresorhus/is' });
  });

  it.each([
    '',
    'react',
    'https://gitlab.com/a/b',
    'https://bitbucket.org/a/b',
    'git@gitlab.com:a/b.git',
    'https://github.com.evil.example/a/b',
    'https://evil.example/github.com/a/b',
    'file:///etc/passwd',
    'ftp://github.com/a/b',
    '../etc/passwd',
    'a/..',
    'a/.',
    '-a/b',
    'a-/b',
    'a--b/c',
    'a b/c',
    'a/b c',
    'a/b;rm -rf /',
    'a/b$(whoami)',
    'a/b\u0000',
    'a/b\nc/d',
    'user@host/a/b',
    `${'a'.repeat(40)}/repo`,
    `owner/${'r'.repeat(101)}`,
    'x'.repeat(400),
  ])('rejects %j', (input) => {
    expect(parseRepoSpec(input)).toBeNull();
  });
});
