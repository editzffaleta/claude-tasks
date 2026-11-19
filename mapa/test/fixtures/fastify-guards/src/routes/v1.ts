import type { FastifyInstance } from 'fastify';
import { authenticateApiKey } from '../guard.js';
import { db } from '../db.js';

/** Routes the hook lets through without a key. */
export const V1_PUBLIC = new Set(['/v1/export-all']);

/** Public API: one hook checks the key for every route registered below it. */
export async function v1Routes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    const route = req.routeOptions?.url ?? '';
    if (!route.startsWith('/v1') || V1_PUBLIC.has(route)) return;
    req.api = await authenticateApiKey(req);
  });

  app.get('/v1/export-all', async (_req, reply) => reply.send(await db.thing.findMany()));

  app.get('/v1/items', async (req, reply) => {
    return reply.send(await db.thing.findMany({ where: { companyId: req.api!.companyId } }));
  });

  app.post('/v1/items', async (req, reply) => {
    return reply.status(201).send(await db.thing.create({ data: { companyId: req.api!.companyId } }));
  });
}
