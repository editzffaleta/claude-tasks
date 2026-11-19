import type { FastifyRequest } from 'fastify';

/** Loads the session and requires a permission. */
export async function guard(req: FastifyRequest, permission?: string) {
  const session = await loadSession(req.cookies.sid);
  if (!session) throw new Error('unauthenticated');
  if (permission && !session.permissions.includes(permission)) throw new Error('forbidden');
  return session;
}

export async function requireStaff(req: FastifyRequest, permission?: string) {
  const staff = await loadStaff(req.cookies.staff);
  if (!staff) throw new Error('staff_login_required');
  return staff;
}

export async function authenticateApiKey(req: FastifyRequest) {
  const key = await findKey(String(req.headers.authorization ?? ''));
  if (!key) throw new Error('api_key_required');
  return key;
}

declare function loadSession(token?: string): Promise<{ permissions: string[] } | null>;
declare function loadStaff(token?: string): Promise<{ id: string } | null>;
declare function findKey(token: string): Promise<{ companyId: string } | null>;
