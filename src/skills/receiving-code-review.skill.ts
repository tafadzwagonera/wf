import { registerSkill } from './skill-registry';

registerSkill({
  id: 'receiving-code-review',
  stages: ['review', 'implement'],
});
