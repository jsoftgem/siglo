import { flow, Step } from '@siglo/core';
import { httpStep } from '@siglo/http';

// Fixture with multi-byte unicode characters and emojis: 🚀 🌟 ⚡
export const unicodeFlow = flow(
  Step.create('🌟_greeting_ステップ', async () => 'こんにちは世界'),
  httpStep('⚡_fast_track', {
    method: 'GET',
    url: 'https://api.example.jp/v1/telemetry',
  }),
);
