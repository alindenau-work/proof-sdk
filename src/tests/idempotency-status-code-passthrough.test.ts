// Regression test: idempotency replay must return the originally-stored HTTP
// status code, not always 200.
//
// Background: a /edit/v2 or /markdown call that diverged returned HTTP 202 with
// `success: false` + `code: 'LIVE_COLLAB_DIVERGED'`. Without this fix, a retry
// against the same idempotency key replayed the SAME body but with HTTP 200 OK,
// so an agent that branched on `if (response.ok)` saw success even though the
// body said the write didn't apply. Same pattern for canonical_required: true
// (HTTP 409) — replays would silently downgrade to 200.

import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const idempotencySource = readFileSync(path.resolve(process.cwd(), 'server/mutation-idempotency.ts'), 'utf8');
const dbSource = readFileSync(path.resolve(process.cwd(), 'server/db.ts'), 'utf8');

// 1. The replay branch threads stored.statusCode through, not a hardcoded 200.
assert(
  /statusCode:\s*stored\.statusCode/.test(idempotencySource),
  'Expected the replay branch to use stored.statusCode (not 200) so retries match the original status',
);
assert(
  !/kind:\s*'replay',\s*\n\s*statusCode:\s*200,/.test(idempotencySource),
  'Expected no `statusCode: 200` literal in the replay branch — that was the bug being fixed',
);

// 2. getStoredIdempotencyRecord returns the persisted statusCode column, with a 200 fallback only when the column is null.
assert(
  /getStoredIdempotencyRecord[\s\S]*?statusCode:[\s\S]*?completedCoordinator\?\.status_code/.test(dbSource),
  'Expected getStoredIdempotencyRecord to surface the persisted status_code column to callers',
);

console.log('✓ idempotency replay returns the originally-stored status code');
