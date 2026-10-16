import { Module } from '@nitrostack/core';
import { GraphModule } from '../graph/graph.module.js';
import { TourTools } from './tour.tools.js';
import { TourPrompts } from './tour.prompts.js';

@Module({
  name: 'tour',
  description: 'Staged, role-based guided tour (tour_next) and the guide_me prompt',
  imports: [GraphModule],
  controllers: [TourTools, TourPrompts],
})
export class TourModule {}
