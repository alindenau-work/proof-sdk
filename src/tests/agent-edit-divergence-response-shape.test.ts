// Regression test: when an agent edit lands in canonical but does NOT converge in the
// live Yjs state (the "silent divergence" failure), the response body must NOT lie to
// the agent. This test walks the response-shape code paths in agent-edit-v2.ts,
// agent-routes.ts, and agent-markdown.ts, asserting that:
//   1. `success` reflects `collabApplied` — never `true` while collab is `pending`.
//   2. `code: 'LIVE_COLLAB_DIVERGED'` is set on every divergence path.
//   3. `canonical_required: true` upgrades the soft-fail (HTTP 202) to hard-fail (409).
//   4. `agent.edit.superseded` is emitted on divergence so polling agents can detect
//      the loss without diffing markdown.
//
// Background: an agent reported `success: true, revision: 141` while the inserted
// content never appeared in the human's editor (`collabApplied: null`,
// `collab.reason: canonical_changed_during_fallback`). The agent confidently briefed
// the human; the human came back saying nothing was there. This test exists so we
// never ship that footgun again.

import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function read(rel: string): string {
  return readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

const editV2 = read('server/agent-edit-v2.ts');
const routes = read('server/agent-routes.ts');
const markdown = read('server/agent-markdown.ts');

// 1. The shared shaping helper exists, exports a `LIVE_COLLAB_DIVERGED` body, and is
//    the single source of truth for the divergence response shape.
assert(
  editV2.includes('export function applyDivergenceShape'),
  'Expected applyDivergenceShape() helper to exist as the single source of truth for divergence responses',
);
assert(
  editV2.includes("'LIVE_COLLAB_DIVERGED'"),
  'Expected divergence shape to surface a LIVE_COLLAB_DIVERGED code so agents can branch on the body alone',
);
assert(
  /success:\s*true,\s*\n\s*collabApplied:\s*true/.test(editV2)
    && /success:\s*false,\s*\n\s*collabApplied:\s*false/.test(editV2),
  'Expected applyDivergenceShape to flip both success and collabApplied together — never one without the other',
);

// 2. The opt-in flag is parsed and threaded through to the helper.
assert(
  editV2.includes('export function readCanonicalRequired'),
  'Expected canonical_required parsing to live in a shared helper',
);
assert(
  editV2.includes('canonicalRequired ? 409 : 202'),
  'Expected canonical_required:true to upgrade divergence to HTTP 409 (hard fail), default 202 (soft fail)',
);

// 3. Both /edit/v2 paths inside applyAgentEditV2 route through applyDivergenceShape, NOT
//    a hand-rolled `success: true` body. (The historical bug was a `success: true`
//    constant in finalizeAgentEditV2Response paired with a 202 status code.)
assert(
  !/return\s*\{\s*\n?\s*status:\s*collabResult\.confirmed\s*\?\s*200\s*:\s*202,\s*\n\s*body:\s*\{\s*\n\s*success:\s*true,/.test(editV2),
  'Expected no remaining hand-rolled `success: true` next to a 202 status — every divergence path must go through applyDivergenceShape',
);
assert(
  /finalizeAgentEditV2Response\([^)]*canonicalRequired/.test(editV2),
  'Expected finalizeAgentEditV2Response to receive canonicalRequired from its callers',
);

// 4. The /edit/v2 handler's own re-verification path also calls applyDivergenceShape so
//    the handler-level merge cannot accidentally re-introduce success:true on divergence.
assert(
  /applyDivergenceShape\(result, \{\s*\n\s*confirmed: collabStatus\.confirmed/.test(routes),
  'Expected the /edit/v2 handler to call applyDivergenceShape after its own re-verification — otherwise the handler can re-write success: true on top of a diverged result',
);
assert(
  routes.includes('readCanonicalRequired(editV2Body)'),
  'Expected the /edit/v2 handler to read canonical_required from the request body',
);

// 5. /markdown propagates canonical_required to the underlying /edit/v2 calls.
assert(
  markdown.includes('canonical_required: request.canonicalRequired'),
  'Expected /markdown to forward canonical_required to its underlying /edit/v2 batches; otherwise the opt-in silently no-ops',
);
assert(
  markdown.includes('canonicalRequired: boolean'),
  'Expected MarkdownImportRequest to carry canonicalRequired so it survives across batches',
);

// 6. /markdown success body hoists collabApplied to the top level (not buried in collab.status).
assert(
  /collabApplied,\s*\n\s*slug,/.test(markdown) || /collabApplied:\s*[a-zA-Z]+,\s*\n\s*slug/.test(markdown),
  'Expected /markdown success body to hoist collabApplied to the top level alongside slug',
);
assert(
  !/^\s*success:\s*true,\s*$/m.test(markdown.split('function successBody')[1] ?? ''),
  'Expected /markdown successBody not to hard-code success: true regardless of underlying convergence',
);

// 7. Divergence emits agent.edit.superseded so polling agents detect the loss.
assert(
  editV2.includes('emitAgentEditSupersededEvent'),
  'Expected an emitAgentEditSupersededEvent helper for the agent.edit.superseded signal',
);
assert(
  editV2.includes("'agent.edit.superseded'"),
  'Expected the superseded event to be wired into the document event log',
);
assert(
  routes.includes('emitAgentEditSupersededEvent'),
  'Expected the /edit/v2 handler to emit agent.edit.superseded when its own re-verification detects divergence',
);

console.log('✓ agent edit divergence response shape locks success/collabApplied/code/canonical_required/superseded');
