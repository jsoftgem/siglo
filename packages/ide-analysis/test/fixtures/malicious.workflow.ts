// Malicious fixture: if evaluated or imported at runtime, this will terminate the process.
if (typeof process !== 'undefined') {
  process.exit(1);
}
throw new Error('Evaluated top-level application code!');

import { flow, Step } from 'siglo';

export const safeFlow = flow('safeWorkflow')
  .then(Step.create('safeStep', async () => 'ok'));
