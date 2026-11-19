import type { FastifyInstance } from 'fastify';
import { db } from '../db.js';

/** A hook that only logs protects nothing. */
export async function otherRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', async (req) => {
    req.log.info({ url: req.url }, 'incoming');
  });

  app.post('/unchecked', async (req, reply) => {
    return reply.status(201).send(await db.thing.create({ data: req.body as object }));
  });

  // a provider's own token, read from a header and compared: the caller is checked
  app.post('/payments/provider/callback', async (req, reply) => {
    const got = req.headers['provider-access-token'];
    if (typeof got !== 'string' || got !== process.env.PROVIDER_TOKEN) return reply.status(401).send();
    await db.thing.create({ data: req.body as object });
    return reply.send({ ok: true });
  });
}
