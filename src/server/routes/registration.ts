import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.ts';
import { generateInvitations, invitationOverview, revokeInvitation, saveRegistrationSettings } from '../../core/invitations.ts';
import { nowSeconds } from '../../core/domain.ts';

export function registerRegistrationRoutes(app: FastifyInstance, context: ServerContext): void {
  const { db, access } = context;
  app.get('/api/admin/registration', async (request, reply) => {
    access.requireIdentity(request, { admin: true });
    reply.header('cache-control', 'no-store');
    return invitationOverview(db);
  });
  app.post<{ Body: { invitation_required?: unknown } }>('/api/admin/registration', async (request, reply) => {
    access.requireIdentity(request, { admin: true, write: true });
    reply.header('cache-control', 'no-store');
    return { settings: saveRegistrationSettings(db, request.body?.invitation_required) };
  });
  app.post<{ Body: { count?: unknown } }>('/api/admin/invitations', async (request, reply) => {
    const who = access.requireIdentity(request, { admin: true, write: true });
    const codes = generateInvitations(db, who.user.id, request.body?.count === undefined ? 1 : request.body.count, nowSeconds());
    reply.header('cache-control', 'no-store');
    return { codes };
  });
  app.post<{ Params: { id: string } }>('/api/admin/invitations/:id/revoke', async (request) => {
    access.requireIdentity(request, { admin: true, write: true });
    revokeInvitation(db, request.params.id, nowSeconds());
    return { ok: true };
  });
}
