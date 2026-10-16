import { HealthCheck, type HealthCheckInterface, type HealthCheckResult } from '@nitrostack/core';
import { StoreService } from '../services/store.service.js';

/**
 * Reports whether the shipped snapshots load. The deployed server is only useful if they do, and
 * a bad deploy (missing data folder, corrupt file) should show up here and not as confusing
 * tool errors. The store caches its index, so repeat checks cost nothing.
 */
@HealthCheck({
  name: 'snapshots',
  description: 'Precomputed graph snapshots are present and valid',
  interval: 60,
})
export class SnapshotsHealthCheck implements HealthCheckInterface {
  private readonly store = new StoreService();

  async check(): Promise<HealthCheckResult> {
    try {
      const infos = await this.store.list();
      const problems = await this.store.problems();
      const real = infos.filter((i) => i.file !== 'sample').length;
      const details = { snapshots: infos.length, repos: infos.map((i) => i.repo), rejected: problems.map((p) => p.file), mode: process.env.RUNTIME_MODE ?? 'snapshot' };
      if (infos.length === 0) return { status: 'down', message: 'No snapshots found: build_graph cannot serve any repo.', details };
      if (problems.length > 0) return { status: 'degraded', message: `${problems.length} snapshot file(s) were rejected as invalid.`, details };
      return { status: 'up', message: real > 0 ? `${infos.length} snapshots loaded` : 'Only the sample snapshot is installed', details };
    } catch (e) {
      return { status: 'down', message: 'Snapshot check failed', details: e instanceof Error ? e.message.slice(0, 200) : 'unknown' };
    }
  }
}
