import { Module } from '@nitrostack/core';
import { GraphTools } from './graph.tools.js';
import { GraphResources } from './graph.resources.js';
import { StoreService } from '../../services/store.service.js';

@Module({
  name: 'graph',
  description: 'Repo graph snapshots and Part A (understand) tools',
  controllers: [GraphTools, GraphResources],
  providers: [StoreService],
  exports: [StoreService],
})
export class GraphModule {}
