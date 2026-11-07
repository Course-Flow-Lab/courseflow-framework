import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';

// An explicit asset list keeps private source and runtime files off the HTTP surface.
const ASSETS = [
  ['/', 'index.html', 'text/html'],
  ['/style.css', 'style.css', 'text/css'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/api.js', 'api.js', 'text/javascript'],
  ['/qa.js', 'qa.js', 'text/javascript'],
  ['/logs.js', 'logs.js', 'text/javascript'],
  ['/invitations.js', 'invitations.js', 'text/javascript'],
  ['/features.js', 'features.js', 'text/javascript'],
  ['/views.js', 'views.js', 'text/javascript'],
] as const;

export function registerWebRoutes(app: FastifyInstance): void {
  for (const [route, file, type] of ASSETS) {
    app.get(route, async (_request, reply) => {
      reply.header('x-content-type-options', 'nosniff');
      reply.header('cache-control', 'no-cache');
      if (route === '/') {
        reply.header('content-security-policy',
          "default-src 'self'; img-src 'self' data: https:; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
      }
      return reply.type(`${type}; charset=utf-8`)
        .send(readFileSync(new URL(`../../web/${file}`, import.meta.url)));
    });
  }
}
