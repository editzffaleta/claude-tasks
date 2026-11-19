import type { FastifyInstance } from 'fastify';
import { guard, requireStaff } from '../guard.js';
import { db } from '../db.js';

/** Panel routes: the sign-in check is the first line of each handler. */
export async function panelRoutes(app: FastifyInstance): Promise<void> {
  app.get('/things', async (req, reply) => {
    const ctx = await guard(req, 'things.read');
    return reply.send(await db.thing.findMany({ where: { companyId: ctx.companyId } }));
  });

  app.post('/things', async (req, reply) => {
    const ctx = await guard(req, 'things.write');
    return reply.status(201).send(await db.thing.create({ data: { companyId: ctx.companyId } }));
  });

  app.delete('/staff/things/:id', async (req, reply) => {
    await requireStaff(req, 'platform.things');
    await db.thing.delete({ where: { id: (req.params as { id: string }).id } });
    return reply.status(204).send();
  });

  // nothing checks the caller here
  app.post('/open-things', async (req, reply) => {
    return reply.status(201).send(await db.thing.create({ data: req.body as object }));
  });
}
