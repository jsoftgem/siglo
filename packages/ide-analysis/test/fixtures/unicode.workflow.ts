import { flow, Step } from '@siglo/core';

// Fixture with multi-byte unicode characters and emojis: 🚀 🌟 ⚡
export const unicodeFlow = flow('🚀_international_workflow')
  .then(Step.create('🌟_greeting_ステップ', async () => 'こんにちは世界'))
  .then(Step.create('⚡_fast_track', async () => 'done'));
