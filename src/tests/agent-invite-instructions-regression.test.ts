// Regression test for the copied agent-invite prompt.
//
// The prompt was rewritten to be lean: the API surface is discoverable from the
// Doc URL itself (Accept: application/json returns a self-describing manifest),
// so the prompt's job is to convey what the link CAN'T — team contract, role
// boundary, identity expectation, and the rules of the room.
//
// This test asserts the prompt:
//   1. Tells the agent to fetch the Doc URL for API discovery rather than reciting endpoints.
//   2. Conveys the team-contract / HandBrake boundary (the irreducible behavioral context).
//   3. Requires a stable X-Agent-Id and a human-readable presence name before document writes.
//   4. Forbids whole-document replacement and HandBrake repo writes by default.
//   5. Does NOT pad the prompt with the old 6-step API bootstrap.

import { readFileSync } from 'node:fs';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const source = readFileSync(new URL('../editor/index.ts', import.meta.url), 'utf8');

// 1. The prompt points the agent at the self-describing Doc URL instead of reciting steps.
const requiredPhrases = [
  // Team contract / HandBrake boundary — what the link can't carry.
  'Proof is the live drafting room for Adam, Pete, Codex, and Claude',
  'HandBrake is the canonical product repo',
  'Proof is collaboration state, not permission to bypass HandBrake process',
  // Identity contract.
  'Pick a stable, unique X-Agent-Id',
  'human-readable presence name',
  'Agent identity: <X-Agent-Id> / <presence-name>',
  // Rules of the room.
  'Stay inside your assigned HandBrake role',
  'reviewer/commenter in Proof',
  'Do not edit the HandBrake repo, run migrations, touch Supabase',
  'one issue, one role branch, one scoped PR, required checks green, no direct pushes to main, and no pulling from another agent branch',
  'Do not replace the whole document unless explicitly asked',
  'If the Doc URL is unreachable',
  // Discovery hint — the part that makes the prompt LEAN.
  'Accept: application/json',
  'self-describing manifest',
  'x-share-token:',
];

for (const phrase of requiredPhrases) {
  assert(source.includes(phrase), `Expected copied agent invite instructions to include: ${phrase}`);
}

// 2. Presence is required, never optional.
assert(
  !source.includes('Optionally set your friendly name in presence'),
  'Agent invite instructions must not describe presence registration as optional',
);

// 3. The legacy 6-step API bootstrap is gone — the link's manifest covers it.
//    These banned phrases were the verbose noise the team complained about.
const forbiddenPhrases = [
  'Confirm the Proof server is reachable',
  'Read current document state with your identity headers',
  'Set your friendly name in presence before doing document work',
  'If you need to insert or append a Markdown blob, use the Markdown import endpoint first',
  'If comments, flags, suggestions, or surgical block edits are useful based on state, apply them with',
  'Then reply briefly with what you changed, what you intentionally did not change',
];
for (const phrase of forbiddenPhrases) {
  assert(
    !source.includes(phrase),
    `Agent invite instructions must NOT recite the verbose 6-step API bootstrap (found: ${phrase}). The Doc URL is self-describing.`,
  );
}

console.log('✓ agent invite prompt: discovery-via-link + team contract + identity + rules of the room');
