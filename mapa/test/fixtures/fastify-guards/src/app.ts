import Fastify from 'fastify';
import { panelRoutes } from './routes/panel.js';
import { v1Routes } from './routes/v1.js';
import { otherRoutes } from './routes/other.js';

export async function buildApp() {
  const app = Fastify();
  await app.register(panelRoutes);
  await app.register(v1Routes);
  await app.register(otherRoutes);
  return app;
}
