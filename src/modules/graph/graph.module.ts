import { Module } from '@nitrostack/core';
import { GraphTools } from './graph.tools.js';

@Module({
  name: 'graph',
  description: 'Repo graph snapshots and Part A (understand) tools',
  controllers: [GraphTools],
})
export class GraphModule {}
