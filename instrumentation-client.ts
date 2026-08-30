// Registers the Vercel BotID client challenge for the public workflow intake.
//
// BotID's server-side checkBotId() only succeeds for paths declared here: the
// client component decides which requests carry the classification headers.
// Adding a protected route to the API without adding it to this list makes the
// server check fail closed for every caller.

import { initBotId } from 'botid/client/core';

initBotId({
  protect: [
    {
      path: '/api/workflow-intake',
      method: 'POST',
    },
  ],
});
