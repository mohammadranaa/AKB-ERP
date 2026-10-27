import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePerm } from '../auth.js';
import { ownerUrl } from '../cli/migrate.js';
import { trialReset } from '../cli/trial.js';
import { forbidden, rule } from '../lib/errors.js';

/** Practice system only: the owner or an admin can wipe everything back to the demo data. */
export async function trialRoutes(app: FastifyInstance) {
  const { config } = app.deps;
  app.post('/reset', { preHandler: requirePerm('users.manage') }, async (req) => {
    if (!config.TRIAL_MODE) throw forbidden('This is not a trial system');
    const { confirm } = z.object({ confirm: z.string() }).parse(req.body);
    if (confirm !== 'RESET') throw rule('Type RESET to confirm');
    const url = ownerUrl();
    if (!url) throw rule('The trial system has no owner database connection configured');
    const log: string[] = [];
    await trialReset(url, (s) => log.push(s));
    req.log.warn({ by: req.user!.username }, 'trial data reset');
    return { ok: true, log };
  });
}
