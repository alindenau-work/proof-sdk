// Regression test for security hardening landed in this batch:
//   - /local/* dashboard routes require loopback callers (Sec#1)
//   - server binds to PROOF_HOST/HOST (default 127.0.0.1) instead of all interfaces (Sec#1)
//   - bridge mutation routes require auth: 'bridge-token' (Sec#2)
//   - tokenless access role is configurable via PROOF_TOKENLESS_ACCESS_ROLE (Sec#3)
//
// These are static-source assertions — fast, deterministic, and they catch
// regressions where someone removes the guard or flips a policy back to "auth: 'none'".

import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function read(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

const indexSource = read('server/index.ts');
const bridgeAuthPolicy = read('server/bridge-auth-policy.ts');
const bridgeSource = read('server/bridge.ts');
const routesSource = read('server/routes.ts');

// Sec#1: server.listen passes the host explicitly; default is loopback.
assert(
  /server\.listen\(PORT,\s*HOST,/.test(indexSource),
  'Expected server.listen to bind PORT,HOST explicitly so the dashboard does not silently expose to the LAN',
);
assert(
  indexSource.includes("process.env.PROOF_HOST")
    && indexSource.includes("'127.0.0.1'"),
  'Expected PROOF_HOST env override with a 127.0.0.1 default',
);
assert(
  indexSource.includes('localDashboardOnly')
    && /app\.get\('\/local\/recent-documents',\s*localDashboardOnly/.test(indexSource)
    && /app\.post\('\/local\/documents\/:slug\/delete',\s*localDashboardOnly/.test(indexSource)
    && /app\.get\('\/local\/open\/:slug',\s*localDashboardOnly/.test(indexSource),
  'Expected every /local/* route to be gated by the loopback-only middleware',
);
assert(
  indexSource.includes('LOCAL_DASHBOARD_FORBIDDEN'),
  'Expected the loopback-only middleware to reject remote callers with LOCAL_DASHBOARD_FORBIDDEN',
);
assert(
  indexSource.includes('PROOF_LOCAL_DASHBOARD_REMOTE_HOSTS'),
  'Expected an explicit env opt-in (PROOF_LOCAL_DASHBOARD_REMOTE_HOSTS) before the dashboard accepts remote callers',
);

// Sec#2: bridge mutation policies require bridge-token, not 'none'.
const bridgeMutationRoutes = [
  '/marks/comment',
  '/comments',
  '/marks/suggest-replace',
  '/marks/suggest-insert',
  '/marks/suggest-delete',
  '/suggestions',
  '/rewrite',
];
for (const route of bridgeMutationRoutes) {
  // The line for the route must contain auth: 'bridge-token'. We check for the
  // route literal AND for the bridge-token classification on the same line.
  const lineRegex = new RegExp(`path:\\s*'${route.replace(/[/-]/g, '\\$&')}'[^}]*auth:\\s*'bridge-token'`);
  assert(
    lineRegex.test(bridgeAuthPolicy),
    `Expected bridge mutation ${route} to require auth: 'bridge-token' (found ${
      lineRegex.test(bridgeAuthPolicy) ? 'OK' : (bridgeAuthPolicy.match(new RegExp(`path:\\s*'${route.replace(/[/-]/g, '\\$&')}'[^}]*auth:\\s*'[a-z-]+'`))?.[0] ?? 'no match')
    })`,
  );
}
// Read-only routes should remain auth: 'none'.
assert(
  /path:\s*'\/state',\s*auth:\s*'none'/.test(bridgeAuthPolicy)
    && /path:\s*'\/marks',\s*auth:\s*'none'/.test(bridgeAuthPolicy),
  'Expected GET /state and GET /marks to keep auth: \'none\' (read paths under the slug-as-secret model)',
);
// Bridge handler accepts owner_bot OR editor for bridge-token routes.
assert(
  /role === 'owner_bot' \|\| role === 'editor'/.test(bridgeSource),
  'Expected the bridge handler to allow editor in addition to owner_bot for bridge-token routes',
);
// Bridge handler reads x-share-token and Bearer in addition to x-bridge-token.
assert(
  bridgeSource.includes("req.header('x-share-token')")
    && bridgeSource.includes("req.header('x-bridge-token')")
    && bridgeSource.includes("Bearer"),
  'Expected getBridgeToken to recognize x-bridge-token, x-share-token, AND Authorization Bearer',
);

// Sec#3: tokenless default role is configurable; the lying comment is gone.
assert(
  routesSource.includes('PROOF_TOKENLESS_ACCESS_ROLE')
    && routesSource.includes('tokenlessDefaultRole'),
  'Expected the tokenless default role to be configurable via PROOF_TOKENLESS_ACCESS_ROLE',
);
assert(
  /tokenlessRole = tokenlessDefaultRole\(\)/.test(routesSource),
  'Expected resolveOpenContextAccess to consult tokenlessDefaultRole rather than hard-coding editor',
);
assert(
  !/Tokenless links default to read-only access\.\s*\n\s*return \{ role: 'editor'/.test(routesSource),
  'Expected the lying "default to read-only" comment to be removed (the code returned editor — comment now matches code or is replaced)',
);

console.log('✓ security hardening: /local/* loopback guard, bridge-token auth, tokenless role override are all in place');
