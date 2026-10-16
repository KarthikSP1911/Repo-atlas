import { Module } from '@nitrostack/core';
import { GraphModule } from '../graph/graph.module.js';
import { ActionsTools } from './actions.tools.js';

@Module({
  name: 'actions',
  description: 'Write-style actions behind a preview and confirm step (export_guide)',
  imports: [GraphModule],
  controllers: [ActionsTools],
})
export class ActionsModule {}
