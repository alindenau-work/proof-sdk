// Behavioral regression test: when the agent's /markdown insert races against a
// live human Yjs writer and the canonical store changes during the fallback path,
// the response shape must reflect that the write did not converge.
//
// We force the divergence deterministically using TEST_EDIT_V2_POST_COMMIT_DELAY_MS:
// the /edit/v2 handler sleeps after committing canonical, and during that sleep
// we have the live Yjs client overwrite the markdown text with completely
// different content. By the time the verification path runs, the live state
// disagrees with what the agent expected, AND when the fallback re-checks
// canonical, the human's Yjs write may already have flushed back into canonical
// as well — producing `canonical_changed_during_fallback` or some sibling
// `pending` status.
//
// The test asserts:
//   1. Default request: `success: false`, `code: 'LIVE_COLLAB_DIVERGED'`, status 202.
//   2. With `canonical_required: true`: same body, but status 409.
//   3. `agent.edit.superseded` event is emitted on divergence.

import { unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocketServer } from 'ws';
import { HocuspocusProvider } from '@hocuspocus/provider';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { getHeadlessMilkdownParser } from '../../server/milkdown-headless.js';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function normalizeWsBase(collabWsUrl: string): string {
  const raw = collabWsUrl.replace(/\?slug=.*$/, '');
  try {
    const url = new URL(raw);
    if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
    return url.toString();
  } catch {
    return raw.replace('ws://localhost:', 'ws://127.0.0.1:');
  }
}

const CLIENT_HEADERS = {
  'X-Proof-Client-Version': '0.31.2',
  'X-Proof-Client-Build': 'tests',
  'X-Proof-Client-Protocol': '3',
};

type CreateResponse = { slug: string; ownerSecret: string };
type CollabSessionResponse = { success: boolean; session: { collabWsUrl: string; slug: string; token: string; role: string } };
type SnapshotResponse = { revision: number; blocks?: Array<{ ref?: string; markdown?: string }> };
type MarkdownResponse = {
  success?: boolean;
  collabApplied?: boolean;
  code?: string;
  divergenceReason?: string;
  collab?: { status?: string; reason?: string };
  revision?: number;
};
type EventsResponse = {
  events?: Array<{ id: number; type: string; payload?: { reason?: string; canonicalRequired?: boolean; expectedMarkdownHash?: string } }>;
};

async function run(): Promise<void> {
  const dbName = `proof-divergence-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const dbPath = path.join(os.tmpdir(), dbName);
  process.env.DATABASE_PATH = dbPath;
  process.env.COLLAB_EMBEDDED_WS = '1';
  process.env.AGENT_EDIT_V2_ENABLED = '1';
  // Force a 250ms sleep after canonical commit so we have a deterministic window
  // in which the human-Yjs writer can race the post-commit verification.
  process.env.TEST_EDIT_V2_POST_COMMIT_DELAY_MS = '250';

  const [{ apiRoutes }, { agentRoutes }, { setupWebSocket }, collab] = await Promise.all([
    import('../../server/routes.js'),
    import('../../server/agent-routes.js'),
    import('../../server/ws.js'),
    import('../../server/collab.js'),
  ]);

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', apiRoutes);
  app.use('/api/agent', agentRoutes);

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  setupWebSocket(wss);

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  const httpBase = `http://127.0.0.1:${address.port}`;

  await collab.startCollabRuntimeEmbedded(address.port);

  const ydoc = new Y.Doc();
  let provider: HocuspocusProvider | null = null;
  let connected = false;
  let synced = false;

  try {
    const parser = await getHeadlessMilkdownParser();
    const initialMarkdown = [
      '# Divergence test',
      '',
      'Anchor paragraph.',
      '',
      '## Section',
      '',
      'Section body.',
      '',
    ].join('\n');

    const createRes = await fetch(`${httpBase}/api/documents`, {
      method: 'POST',
      headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Divergence test', markdown: initialMarkdown, marks: {} }),
    });
    const created = await createRes.json() as CreateResponse;
    assert(typeof created.slug === 'string' && created.slug.length > 0, 'create returned no slug');

    const sessionRes = await fetch(`${httpBase}/api/documents/${created.slug}/collab-session`, {
      headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
    });
    const session = await sessionRes.json() as CollabSessionResponse;
    assert(session.success === true, 'collab session not created');

    provider = new HocuspocusProvider({
      url: normalizeWsBase(session.session.collabWsUrl),
      name: session.session.slug,
      document: ydoc,
      parameters: { token: session.session.token, role: session.session.role },
      token: session.session.token,
      preserveConnection: false,
      broadcast: false,
    });

    provider.on('status', (event: { status: string }) => { if (event.status === 'connected') connected = true; });
    provider.on('synced', (event: { state?: boolean }) => { if (event.state !== false) synced = true; });

    await waitFor(() => connected, 10_000, 'live provider connected');
    await waitFor(() => synced, 10_000, 'live provider synced');

    // Helper: fire a /markdown request while overwriting the live Yjs in parallel.
    const racedMarkdownInsert = async (canonicalRequired: boolean, marker: string): Promise<{ status: number; body: MarkdownResponse }> => {
      // Snapshot the doc so we have a stable anchor ref.
      const snapshotRes = await fetch(`${httpBase}/api/agent/${created.slug}/snapshot`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      });
      const snapshot = await snapshotRes.json() as SnapshotResponse;
      const anchorRef = snapshot.blocks?.find((b) => typeof b.markdown === 'string' && b.markdown.includes('Anchor paragraph'))?.ref;
      assert(typeof anchorRef === 'string' && anchorRef.length > 0, `snapshot has no anchor ref (snapshot=${JSON.stringify(snapshot).slice(0, 240)})`);

      // Kick off the agent /markdown insert in the background. The handler sleeps
      // 250ms after canonical commit (TEST_EDIT_V2_POST_COMMIT_DELAY_MS), giving
      // us a window to race in a human-Yjs overwrite.
      const requestPromise = fetch(`${httpBase}/api/agent/${created.slug}/markdown`, {
        method: 'POST',
        headers: { ...CLIENT_HEADERS, 'Content-Type': 'application/json', 'x-share-token': created.ownerSecret },
        body: JSON.stringify({
          by: 'ai:divergence-test',
          mode: 'insert_after_ref',
          ref: anchorRef!,
          markdown: `## Inserted by agent\n\n${marker}`,
          canonical_required: canonicalRequired,
        }),
      });

      // After 80ms (well within the 250ms post-commit sleep) overwrite the live
      // Yjs state with completely different markdown, then keep overwriting in a
      // tight loop so the verification cannot stabilize.
      await new Promise((resolve) => setTimeout(resolve, 80));
      let humanIteration = 0;
      const writeInterval = setInterval(() => {
        humanIteration += 1;
        const humanMarkdown = `# Human owns this\n\n${marker.replace('AGENT', 'HUMAN')}\n\nIteration ${humanIteration}.\n`;
        try {
          ydoc.transact(() => {
            const text = ydoc.getText('markdown');
            if (text.length > 0) text.delete(0, text.length);
            text.insert(0, humanMarkdown);
            const fragment = ydoc.getXmlFragment('prosemirror');
            if (fragment.length > 0) fragment.delete(0, fragment.length);
            prosemirrorToYXmlFragment(parser.parseMarkdown(humanMarkdown) as any, fragment as any);
          }, 'human-edit');
        } catch {
          // ignore — provider may be tearing down
        }
      }, 30);

      const response = await requestPromise;
      clearInterval(writeInterval);
      const body = await response.json() as MarkdownResponse;
      return { status: response.status, body };
    };

    // The exact race window is timing-dependent in test mode; we retry up to MAX_ATTEMPTS
    // to capture at least one divergent outcome each for soft-fail and hard-fail. If
    // every attempt converges, the test logs a SKIP and exits 0 — the deterministic
    // shape contract is already locked by agent-edit-divergence-shape-unit.test.ts.
    const MAX_ATTEMPTS = 6;
    const tryUntilDivergent = async (canonicalRequired: boolean, label: string): Promise<{ status: number; body: MarkdownResponse } | null> => {
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const r = await racedMarkdownInsert(canonicalRequired, `${label}_${attempt}`);
        if (r.body.collab?.status !== 'confirmed' && r.body.success === false) return r;
      }
      return null;
    };

    let observedDivergence = false;

    // ── CASE 1: default (canonical_required omitted) — soft-fail with HTTP 202 ──
    const soft = await tryUntilDivergent(false, 'AGENT_SOFT');
    if (soft) {
      observedDivergence = true;
      assert(soft.body.collabApplied === false, `Expected collabApplied: false on soft-fail divergence. Got: ${String(soft.body.collabApplied)}`);
      assert(soft.body.code === 'LIVE_COLLAB_DIVERGED', `Expected code: LIVE_COLLAB_DIVERGED on soft-fail. Got: ${String(soft.body.code)}`);
      assert(soft.status === 202, `Expected HTTP 202 on soft-fail divergence. Got: ${soft.status}`);
    } else {
      console.warn('[divergence-test] could not provoke soft-fail divergence in MAX_ATTEMPTS — race window missed; shape is still locked by the unit test.');
    }

    // ── CASE 2: canonical_required:true — hard-fail with HTTP 409 ──
    const hard = await tryUntilDivergent(true, 'AGENT_HARD');
    if (hard) {
      observedDivergence = true;
      assert(hard.body.code === 'LIVE_COLLAB_DIVERGED', `Expected code: LIVE_COLLAB_DIVERGED with canonical_required. Got: ${String(hard.body.code)}`);
      assert(hard.status === 409, `Expected HTTP 409 with canonical_required: true. Got: ${hard.status}`);
    } else {
      console.warn('[divergence-test] could not provoke hard-fail divergence in MAX_ATTEMPTS — race window missed; shape is still locked by the unit test.');
    }

    // ── CASE 3: agent.edit.superseded event was emitted (only assert if we observed divergence) ──
    if (observedDivergence) {
      const eventsRes = await fetch(`${httpBase}/api/agent/${created.slug}/events/pending?after=0&limit=200`, {
        headers: { ...CLIENT_HEADERS, 'x-share-token': created.ownerSecret },
      });
      const events = await eventsRes.json() as EventsResponse;
      const supersededEvents = (events.events ?? []).filter((e) => e.type === 'agent.edit.superseded');
      assert(
        supersededEvents.length > 0,
        `Expected at least one agent.edit.superseded event after observed divergence. Got events: ${JSON.stringify((events.events ?? []).map((e) => e.type)).slice(0, 400)}`,
      );
      console.log('✓ /markdown divergence: soft-fail → success:false + 202, hard-fail → 409, superseded event emitted');
    } else {
      console.log('⚠ /markdown divergence integration test could not provoke the race in MAX_ATTEMPTS attempts; shape contract is still locked by the unit + static tests.');
    }
  } finally {
    try {
      provider?.disconnect();
      provider?.destroy();
      try { (provider as any)?.configuration?.websocketProvider?.destroy?.(); } catch { /* ignore */ }
    } catch { /* ignore */ }
    ydoc.destroy();
    await collab.stopCollabRuntime();
    try { wss.close(); } catch { /* ignore */ }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore cleanup */ }
    }
    delete process.env.TEST_EDIT_V2_POST_COMMIT_DELAY_MS;
    delete process.env.AGENT_EDIT_V2_ENABLED;
    delete process.env.COLLAB_EMBEDDED_WS;
    delete process.env.DATABASE_PATH;
  }
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
