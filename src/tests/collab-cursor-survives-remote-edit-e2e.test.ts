// End-to-end regression test: when one browser inserts text earlier in the
// document, the other browser's caret must stay where the user clicked.
//
// This catches the bug where stabilizeCursorAfterRemoteYjsTransaction was
// re-applying a stale absolute-position snapshot on every Yjs-origin
// transaction, dragging the local caret backward by exactly the size of the
// remote insertion. The static regression test enforces the guard exists; this
// test enforces the resulting behavior in a real Chromium browser.
//
// Skipped (with a clear log line) when Playwright Chromium isn't installed,
// so the suite still runs in environments without browsers.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const PORT = 4310 + Math.floor(Math.random() * 80);
const HOST = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `proof-cursor-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);

async function waitForServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${HOST}/healthz`).catch(() => fetch(`${HOST}/`));
      if (r.ok || r.status === 404) return;
    } catch { /* not yet */ }
    await sleep(150);
  }
  throw new Error(`Server did not come up on ${HOST} within ${timeoutMs}ms`);
}

function findChromiumExecutable(): string | null {
  const cacheRoot = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!existsSync(cacheRoot)) return null;
  const candidates = [
    `chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
    `chromium-1208/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
    `chromium-1208/chrome-linux/chrome`,
  ];
  for (const c of candidates) {
    const full = path.join(cacheRoot, c);
    if (existsSync(full)) return full;
  }
  return null;
}

async function tryImportPlaywright(): Promise<typeof import('playwright') | null> {
  try {
    return (await import('playwright')) as typeof import('playwright');
  } catch {
    return null;
  }
}

async function createDoc(initialMarkdown: string): Promise<{ slug: string; token: string; tokenUrl: string }> {
  const r = await fetch(`${HOST}/documents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ markdown: initialMarkdown }),
  });
  const data = await r.json() as { slug: string; accessToken: string; tokenPath: string };
  assert(typeof data.slug === 'string' && data.slug.length > 0, 'Doc creation did not return a slug');
  return { slug: data.slug, token: data.accessToken, tokenUrl: `${HOST}${data.tokenPath}` };
}

async function run(): Promise<void> {
  const playwright = await tryImportPlaywright();
  const chromiumPath = findChromiumExecutable();
  if (!playwright || !chromiumPath) {
    console.log('⚠ collab-cursor-survives-remote-edit-e2e.test: Playwright Chromium unavailable, skipping');
    return;
  }
  const { chromium } = playwright;

  const tmpProfileRoot = mkdtempSync(path.join(os.tmpdir(), 'proof-cursor-e2e-prof-'));
  let server: ChildProcess | null = null;
  let aCtx: import('playwright').BrowserContext | null = null;
  let bCtx: import('playwright').BrowserContext | null = null;

  try {
    server = spawn('npx', ['tsx', 'server/index.ts'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        COLLAB_EMBEDDED_WS: '1',
        DATABASE_PATH: DB_PATH,
        // Force a fresh signing secret so we don't share state with a long-running dev server.
        PROOF_COLLAB_SIGNING_SECRET: 'TGVnZW5kQ29sbGFiQ29sbGFiU2VjcmV0Rm9yVGVzdElzMzJCeXRlcw==',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverDied = false;
    server.on('exit', (code) => { if (code !== null && code !== 0) serverDied = true; });
    server.stdout?.on('data', () => { /* drain */ });
    server.stderr?.on('data', () => { /* drain */ });

    await waitForServer(15000);
    if (serverDied) throw new Error('Server exited before tests could run');

    const initial = '# E2E cursor test\n\nAlpha line.\n\nBravo line.\n\nCharlie line.\n\nDelta line target.\n\nEcho line.\n';
    const doc = await createDoc(initial);

    async function openSession(name: string): Promise<{ ctx: import('playwright').BrowserContext; page: import('playwright').Page }> {
      const ctx = await chromium.launchPersistentContext(path.join(tmpProfileRoot, name), {
        headless: true,
        executablePath: chromiumPath!,
        viewport: { width: 1280, height: 900 },
      });
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto(doc.tokenUrl, { waitUntil: 'load' });
      const anon = page.locator('button:has-text("Continue anonymously")');
      if (await anon.isVisible().catch(() => false)) await anon.click();
      await page.waitForSelector('.ProseMirror');
      await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent?.includes('Echo line'), null, { timeout: 15000 });
      return { ctx, page };
    }

    const a = await openSession('A');
    aCtx = a.ctx;
    const b = await openSession('B');
    bCtx = b.ctx;

    // A clicks at the END of "Delta line target." and types "X" later — we want the
    // typed "X" to land contiguous with that text, even after B inserts characters
    // earlier in the doc.
    const aDelta = a.page.locator('.ProseMirror p').nth(3);
    await aDelta.scrollIntoViewIfNeeded();
    const aBox = await aDelta.boundingBox();
    assert(!!aBox, 'Could not measure Delta paragraph in A');
    await a.page.mouse.click(aBox!.x + aBox!.width - 6, aBox!.y + aBox!.height / 2);
    await a.page.waitForTimeout(200);

    // B clicks at the start of "Alpha line." and types remote characters.
    const bAlpha = b.page.locator('.ProseMirror p').nth(0);
    await bAlpha.scrollIntoViewIfNeeded();
    const bBox = await bAlpha.boundingBox();
    assert(!!bBox, 'Could not measure Alpha paragraph in B');
    await b.page.mouse.click(bBox!.x + 6, bBox!.y + bBox!.height / 2);
    // The editor defers a syncPointerCaret via setTimeout(0); wait for it to settle
    // before pressing Home, otherwise the deferred handler clobbers the navigation.
    await b.page.waitForTimeout(120);
    await b.page.keyboard.press('Home');
    await b.page.waitForTimeout(150);
    await b.page.keyboard.type('REMOTE-', { delay: 60 });

    // Allow the remote update to land in A.
    await a.page.waitForTimeout(800);

    // A types its own marker — must land at the end of "Delta line target.", not earlier.
    await a.page.keyboard.type('|HERE', { delay: 60 });
    await a.page.waitForTimeout(800);

    const finalText = await a.page.evaluate(() => document.querySelector('.ProseMirror')?.textContent ?? '');
    assert(
      /Delta line target\.\|HERE/.test(finalText),
      `Expected A's typed "|HERE" to land at the end of "Delta line target.". Got: ${JSON.stringify(finalText)}`,
    );
    assert(
      /REMOTE-Alpha line\./.test(finalText),
      `Expected B's typed "REMOTE-" to land at the start of "Alpha line.". Got: ${JSON.stringify(finalText)}`,
    );

    // And cross-check: A's typed text must NOT have leaked backward (the bug
    // would have placed the chars several positions earlier within Delta).
    assert(
      !/Delta line targ\|HERE/.test(finalText),
      `Caret regressed inside Delta paragraph (off-by-N due to remote insert). Got: ${JSON.stringify(finalText)}`,
    );

    console.log('✓ local caret survives concurrent remote edits in another paragraph');
  } finally {
    if (aCtx) await aCtx.close().catch(() => {});
    if (bCtx) await bCtx.close().catch(() => {});
    if (server && !server.killed) {
      server.kill('SIGTERM');
      // Give it a moment to release the port before the next test.
      await sleep(300);
      if (!server.killed) server.kill('SIGKILL');
    }
    try { rmSync(tmpProfileRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(`${DB_PATH}${suffix}`); } catch { /* ignore */ }
    }
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
