import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IssuesFileSchema } from '../src/services/issues.schema.js';
import { MAX_SNAPSHOT_BYTES, StoreService, parseSnapshotId } from '../src/services/store.service.js';

/** Gate for what ships in the deploy zip: every file in data/snapshots must be loadable. */
describe('shipped snapshots (data/snapshots)', () => {
  const store = new StoreService();
  store.dir = 'data/snapshots';

  it('has no rejected files and at least the sample', async () => {
    expect(await store.problems()).toEqual([]);
    expect((await store.list()).length).toBeGreaterThanOrEqual(1);
  });

  it('every snapshot is under the size cap, summarises, and never contains tokens or emails', async () => {
    for (const info of await store.list()) {
      const file = path.join('data/snapshots', `${info.file}.json`);
      expect(fs.statSync(file).size, info.id).toBeLessThan(MAX_SNAPSHOT_BYTES);
      const text = fs.readFileSync(file, 'utf8');
      expect(text, info.id).not.toMatch(/github_pat_|ghp_[A-Za-z0-9]{20}|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      const s = await store.summary(info.id);
      expect(s.counts.nodes.file, info.id).toBeGreaterThan(0);
      expect(s.limits.length).toBeGreaterThan(0);
      expect(Object.keys(s.languages).every((l) => /^[a-z0-9+#-]+$/.test(l) && !/^\d+$/.test(l)), `${info.id} languages ${Object.keys(s.languages)}`).toBe(true);
    }
  });

  it('every issues file matches its snapshot id and the schema', async () => {
    for (const info of await store.list()) {
      const f = path.join('data/snapshots', `${info.file}.issues.json`);
      if (!fs.existsSync(f)) continue;
      const parsed = IssuesFileSchema.parse(JSON.parse(fs.readFileSync(f, 'utf8')));
      expect(parsed.snapshotId).toBe(info.id);
      expect(parseSnapshotId(parsed.snapshotId)).not.toBeNull();
      expect(Date.parse(parsed.fetchedAt)).not.toBeNaN();
    }
  });
});
