import { McpApp, Module, ConfigModule } from '@nitrostack/core';
import { GraphModule } from './modules/graph/graph.module.js';
import { TourModule } from './modules/tour/tour.module.js';
import { ContributeModule } from './modules/contribute/contribute.module.js';
import { ActionsModule } from './modules/actions/actions.module.js';
import { SystemHealthCheck } from './health/system.health.js';

/**
 * Root Application Module
 * 
 * This is the main module that bootstraps the MCP server.
 * It registers all feature modules and health checks.
 */
@McpApp({
  module: AppModule,
  server: {
    name: 'repoatlas',
    version: '1.0.0'
  },
  logging: {
    level: 'info'
  }
})
@Module({
  name: 'app',
  description: 'Root application module',
  imports: [
    ConfigModule.forRoot(),
    GraphModule,
    TourModule,
    ContributeModule,
    ActionsModule,
  ],
  providers: [
    // Health Checks
    SystemHealthCheck,
  ]
})
export class AppModule {}

