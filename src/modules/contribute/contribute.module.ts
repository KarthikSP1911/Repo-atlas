import { Module } from '@nitrostack/core';
import { GraphModule } from '../graph/graph.module.js';
import { ContributeTools } from './contribute.tools.js';
import { LocalizeTools } from './localize.tools.js';

@Module({
  name: 'contribute',
  description: 'Part B tools: contributor profile, candidate issues, localization, scoring',
  imports: [GraphModule],
  controllers: [ContributeTools, LocalizeTools],
})
export class ContributeModule {}
