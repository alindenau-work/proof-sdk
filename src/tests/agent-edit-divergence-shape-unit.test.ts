// Unit-level regression test for applyDivergenceShape.
//
// The integration test (agent-edit-divergence-canonical-required.test.ts) tries
// to provoke a real race between an agent /markdown insert and a live Yjs
// writer; that test is a best-effort signal but the timing isn't 100%
// reproducible. This unit test is the deterministic guarantee — it asserts the
// shape function in agent-edit-v2.ts produces the contracted output for every
// branch, regardless of when the verification thread happens to wake up.

import { applyDivergenceShape, readCanonicalRequired, type AgentEditV2Result } from '../../server/agent-edit-v2.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function freshResult(): AgentEditV2Result {
  return {
    status: 200,
    body: {
      slug: 'unit-test',
      revision: 7,
      collab: { status: 'pending', reason: 'sync_timeout' },
    },
  };
}

// 1. Confirmed → success: true, collabApplied: true, status preserved (200).
{
  const r = applyDivergenceShape(freshResult(), { confirmed: true, canonicalRequired: false, reason: null });
  assert(r.status === 200, `confirmed should keep 200, got ${r.status}`);
  assert(r.body.success === true, `confirmed should set success: true, got ${String(r.body.success)}`);
  assert(r.body.collabApplied === true, `confirmed should set collabApplied: true, got ${String(r.body.collabApplied)}`);
  assert(r.body.code === undefined, `confirmed should not set code, got ${String(r.body.code)}`);
}

// 2. Diverged + canonical_required:false → success: false, collabApplied: false,
//    code: LIVE_COLLAB_DIVERGED, status 202 (soft fail).
{
  const r = applyDivergenceShape(freshResult(), {
    confirmed: false,
    canonicalRequired: false,
    reason: 'canonical_changed_during_fallback',
  });
  assert(r.status === 202, `soft-fail divergence should be HTTP 202, got ${r.status}`);
  assert(r.body.success === false, `soft-fail divergence should set success: false, got ${String(r.body.success)}`);
  assert(r.body.collabApplied === false, `soft-fail divergence should set collabApplied: false, got ${String(r.body.collabApplied)}`);
  assert(r.body.code === 'LIVE_COLLAB_DIVERGED', `soft-fail divergence should set code: LIVE_COLLAB_DIVERGED, got ${String(r.body.code)}`);
  assert(
    typeof r.body.error === 'string' && (r.body.error as string).includes('canonical document store but the live Yjs state did not converge'),
    `soft-fail divergence should set a human-readable error string, got ${String(r.body.error)}`,
  );
  assert(
    r.body.divergenceReason === 'canonical_changed_during_fallback',
    `soft-fail divergence should preserve the divergence reason, got ${String(r.body.divergenceReason)}`,
  );
  assert(
    typeof r.body.hint === 'string' && (r.body.hint as string).includes('canonical_required'),
    `soft-fail divergence should hint at canonical_required, got ${String(r.body.hint)}`,
  );
}

// 3. Diverged + canonical_required:true → status 409 (hard fail), no canonical_required hint.
{
  const r = applyDivergenceShape(freshResult(), {
    confirmed: false,
    canonicalRequired: true,
    reason: 'canonical_changed_during_fallback',
  });
  assert(r.status === 409, `hard-fail divergence should be HTTP 409, got ${r.status}`);
  assert(r.body.success === false, `hard-fail divergence should set success: false, got ${String(r.body.success)}`);
  assert(r.body.code === 'LIVE_COLLAB_DIVERGED', `hard-fail divergence should set code: LIVE_COLLAB_DIVERGED, got ${String(r.body.code)}`);
  assert(r.body.hint === undefined, `hard-fail divergence should not include the canonical_required hint, got ${String(r.body.hint)}`);
}

// 4. readCanonicalRequired: accepts boolean, the string 'true', and snake_case + camelCase.
{
  assert(readCanonicalRequired({}) === false, 'readCanonicalRequired({}) should be false');
  assert(readCanonicalRequired({ canonical_required: true }) === true, 'snake_case true should be true');
  assert(readCanonicalRequired({ canonicalRequired: true }) === true, 'camelCase true should be true');
  assert(readCanonicalRequired({ canonical_required: 'true' }) === true, 'string "true" should be true');
  assert(readCanonicalRequired({ canonical_required: 1 } as unknown) === false, 'numeric 1 must NOT be coerced — only strict true/"true" enables hard-fail');
  assert(readCanonicalRequired(null) === false, 'null body should be false');
  assert(readCanonicalRequired('not an object') === false, 'string body should be false');
}

console.log('✓ applyDivergenceShape produces the contracted body/status across confirmed, soft-fail, and hard-fail branches');
