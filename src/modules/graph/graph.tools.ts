import { ToolDecorator as Tool, z, ExecutionContext, Injectable } from '@nitrostack/core';

/**
 * Graph tools.
 *
 * Phase 0 placeholder: `ping_repoatlas` only proves the server boots and a tool
 * is callable. It is replaced by `build_graph` and the Part A tools in Phase 4.
 */
@Injectable()
export class GraphTools {
  @Tool({
    name: 'ping_repoatlas',
    description:
      'Health ping for the RepoAtlas server. Returns the server name, version and runtime mode. Takes no repo data.',
    inputSchema: z.object({
      echo: z.string().max(100).optional().describe('Optional text to echo back'),
    }),
    examples: {
      request: { echo: 'hello' },
      response: {
        ok: true,
        server: 'repoatlas',
        version: '1.0.0',
        runtimeMode: 'snapshot',
        echo: 'hello',
      },
    },
  })
  async ping(input: { echo?: string }, ctx: ExecutionContext) {
    ctx.logger.info('ping_repoatlas called');
    return {
      ok: true,
      server: 'repoatlas',
      version: '1.0.0',
      runtimeMode: process.env.RUNTIME_MODE ?? 'snapshot',
      echo: input.echo ?? null,
    };
  }
}
