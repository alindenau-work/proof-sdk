import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiRoutes } from './routes.js';
import { agentRoutes } from './agent-routes.js';
import { closeRoom, setupWebSocket } from './ws.js';
import { createBridgeMountRouter } from './bridge.js';
import { getCollabRuntime, invalidateCollabDocument, startCollabRuntimeEmbedded } from './collab.js';
import { discoveryRoutes } from './discovery-routes.js';
import { shareWebRoutes } from './share-web-routes.js';
import {
  capabilitiesPayload,
  enforceApiClientCompatibility,
  enforceBridgeClientCompatibility,
} from './client-capabilities.js';
import { getBuildInfo } from './build-info.js';
import {
  addEvent,
  createDocumentAccessToken,
  deleteDocument,
  getDocument,
  listActiveDocuments,
  revokeDocumentAccessTokens,
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || '4000', 10);

/**
 * The bind host. Defaults to 127.0.0.1 (loopback only) so a casual `npm run serve`
 * does NOT silently expose the dashboard, every doc, and the share-token-minting
 * `/local/open/:slug` endpoint to anyone on the same Wi-Fi network. To accept LAN
 * traffic (e.g. for collaborating with a colleague on the same network), set
 * `PROOF_HOST=0.0.0.0` (or a specific interface IP) explicitly.
 *
 * Background: the prior default was Node's default of `::` (every interface), and
 * a console message claimed `127.0.0.1` while the actual bind was wide open. That
 * combination is why this guard exists.
 */
const HOST = (process.env.PROOF_HOST || process.env.HOST || '127.0.0.1').trim();

const LOCAL_DASHBOARD_REMOTE_HOSTS_ALLOWED = (() => {
  const raw = (process.env.PROOF_LOCAL_DASHBOARD_REMOTE_HOSTS || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
})();

/**
 * Block remote callers from the dashboard surface. The /local/* routes have NO auth
 * checks: anyone who can reach them can list every document, mint a fresh editor
 * token for any of them, and delete any of them. Keeping that surface available to
 * the loopback interface is fine on a developer machine; exposing it to the LAN is
 * a catastrophe. The bind-host change above already prevents most of this exposure,
 * but if an operator opts into LAN binding they should still gate the dashboard
 * itself behind an explicit `PROOF_LOCAL_DASHBOARD_REMOTE_HOSTS=1` opt-in.
 */
function isLoopbackRequest(req: import('express').Request): boolean {
  const ip = (req.ip || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  // Some proxies forward `req.connection.remoteAddress` differently; check both.
  const remote = ((req.socket as { remoteAddress?: string } | undefined)?.remoteAddress || '')
    .replace(/^::ffff:/, '');
  return remote === '127.0.0.1' || remote === '::1' || remote === 'localhost';
}

function localDashboardOnly(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction): void {
  if (LOCAL_DASHBOARD_REMOTE_HOSTS_ALLOWED || isLoopbackRequest(req)) {
    next();
    return;
  }
  res.status(403).json({
    success: false,
    code: 'LOCAL_DASHBOARD_FORBIDDEN',
    error: 'The /local/* dashboard surface is restricted to loopback callers. Set PROOF_LOCAL_DASHBOARD_REMOTE_HOSTS=1 to opt into remote access.',
  });
}
const DEFAULT_ALLOWED_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:4000',
  'http://127.0.0.1:4000',
  'null',
];

function parseAllowedCorsOrigins(): Set<string> {
  const configured = (process.env.PROOF_CORS_ALLOW_ORIGINS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  return new Set(configured.length > 0 ? configured : DEFAULT_ALLOWED_CORS_ORIGINS);
}

async function main(): Promise<void> {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('error', (error) => {
    console.error('[server] WebSocketServer error (non-fatal):', error);
  });
  const allowedCorsOrigins = parseAllowedCorsOrigins();

  app.use(express.json({ limit: '10mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use(express.static(path.join(__dirname, '..', 'dist'), {
    etag: false,
    index: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    },
  }));

  app.use((req, res, next) => {
    const originHeader = req.header('origin');
    if (originHeader && allowedCorsOrigins.has(originHeader)) {
      res.setHeader('Access-Control-Allow-Origin', originHeader);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      [
        'Content-Type',
        'Authorization',
        'X-Proof-Client-Version',
        'X-Proof-Client-Build',
        'X-Proof-Client-Protocol',
        'x-share-token',
        'x-bridge-token',
        'x-auth-poll-token',
        'X-Agent-Id',
        'X-Window-Id',
        'X-Document-Id',
        'Idempotency-Key',
        'X-Idempotency-Key',
      ].join(', '),
    );
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proof SDK</title>
    <style>
      :root { color-scheme: light; }
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        margin: 0;
        color: #17261d;
        background: #f7faf5;
      }
      main {
        max-width: 820px;
        margin: 0 auto;
        padding: 48px 24px;
      }
      h1 { font-size: 2.35rem; margin: 0 0 0.5rem; letter-spacing: 0; }
      p { font-size: 1rem; line-height: 1.6; color: #4a5a51; }
      label { display: block; font-size: 0.8rem; font-weight: 700; color: #34483b; margin: 0 0 6px; }
      input[type="text"], input[type="file"] {
        box-sizing: border-box;
        width: 100%;
        border: 1px solid #c8d6cc;
        border-radius: 8px;
        background: #fff;
        color: #17261d;
        font: inherit;
        padding: 11px 12px;
      }
      button {
        appearance: none;
        border: 0;
        border-radius: 8px;
        background: #17261d;
        color: #fff;
        cursor: pointer;
        font: inherit;
        font-size: 0.9rem;
        font-weight: 700;
        padding: 11px 14px;
      }
      button:disabled { cursor: not-allowed; opacity: 0.6; }
      code { background: #eaf2e6; padding: 0.2rem 0.35rem; border-radius: 4px; }
      a { color: #266854; }
      .panel {
        background: #fff;
        border: 1px solid #dce7de;
        border-radius: 8px;
        padding: 18px;
        margin-top: 18px;
      }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 22px; }
      .row { display: flex; gap: 10px; align-items: flex-end; }
      .status { min-height: 1.4em; margin-top: 10px; font-size: 0.85rem; color: #526157; }
      .error { color: #b42318; }
      .recent { margin-top: 22px; }
      .recent-header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
      .recent-list { display: grid; gap: 8px; margin-top: 12px; }
      .recent-item {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding: 11px 12px;
        border: 1px solid #dce7de;
        border-radius: 8px;
        background: #fff;
      }
      .recent-item:hover { border-color: #a9bcaf; background: #fbfdf9; }
      .recent-copy { min-width: 0; }
      .recent-actions { display: flex; gap: 8px; align-items: center; }
      .recent-open {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 38px;
        border-radius: 8px;
        background: #17261d;
        color: #fff;
        font-size: 0.88rem;
        font-weight: 700;
        padding: 0 12px;
        text-decoration: none;
      }
      .recent-open:hover { background: #25382c; }
      .danger-button { background: #9f1d17; }
      .danger-button:hover:not(:disabled) { background: #7f1712; }
      .recent-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 700; }
      .recent-meta { color: #66746b; font-size: 0.78rem; white-space: nowrap; }
      @media (max-width: 720px) {
        main { padding: 28px 16px; }
        .grid { grid-template-columns: 1fr; }
        .row { display: block; }
        button { width: 100%; margin-top: 10px; }
        .recent-item { grid-template-columns: 1fr; }
        .recent-actions { align-items: stretch; flex-direction: column; }
        .recent-open { width: 100%; box-sizing: border-box; margin-top: 10px; }
        .recent-meta { white-space: normal; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Start a Proof draft</h1>
      <p>Create a blank shared Markdown draft or import a local <code>.md</code> file. Proof is the live collaboration room; export the final Markdown back to your computer when you are ready to package repo work.</p>

      <section class="grid" aria-label="Create or import a document">
        <form class="panel" id="blank-form">
          <h2>Create blank draft</h2>
          <label for="blank-title">Draft title</label>
          <div class="row">
            <input id="blank-title" type="text" value="Untitled Proof draft" />
            <button type="submit">Create</button>
          </div>
          <div class="status" id="blank-status"></div>
        </form>

        <form class="panel" id="import-form">
          <h2>Import Markdown</h2>
          <label for="markdown-file">Markdown file</label>
          <div class="row">
            <input id="markdown-file" type="file" accept=".md,.markdown,text/markdown,text/plain" />
            <button type="submit">Import</button>
          </div>
          <div class="status" id="import-status"></div>
        </form>
      </section>

      <section class="recent" aria-label="Recent Proof drafts">
        <div class="recent-header">
          <h2>Recent drafts</h2>
          <button type="button" id="refresh-recent">Refresh</button>
        </div>
        <div class="status" id="recent-status">Loading recent drafts...</div>
        <div class="recent-list" id="recent-list"></div>
      </section>

      <p>Agent docs remain available at <a href="/agent-docs">/agent-docs</a>.</p>
    </main>
    <script>
      function setStatus(id, message, isError) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = message;
        el.className = isError ? 'status error' : 'status';
      }

      async function createDocument(payload) {
        var response = await fetch('/documents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        var data = await response.json().catch(function () { return {}; });
        if (!response.ok) {
          throw new Error(data.error || 'Could not create Proof draft');
        }
        return data;
      }

      function openCreatedDocument(data) {
        var target = data.tokenUrl || data.shareUrl || data.url;
        if (!target) throw new Error('Created document did not return a share URL');
        window.location.href = target;
      }

      function formatDate(value) {
        if (!value) return '';
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return '';
        return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      }

      async function deleteRecentDocument(doc, button) {
        var title = doc.title || doc.slug || 'Untitled draft';
        var confirmed = window.confirm('Delete "' + title + '" from Proof drafts? This removes it from the shared dashboard and disables existing share links.');
        if (!confirmed) return;
        var previousText = button.textContent;
        button.disabled = true;
        button.textContent = 'Deleting...';
        setStatus('recent-status', 'Deleting "' + title + '"...', false);
        try {
          var response = await fetch('/local/documents/' + encodeURIComponent(doc.slug) + '/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title })
          });
          var data = await response.json().catch(function () { return {}; });
          if (!response.ok || data.success !== true) {
            throw new Error(data.error || 'Could not delete draft');
          }
          await loadRecentDocuments();
          setStatus('recent-status', 'Deleted "' + title + '".', false);
        } catch (error) {
          button.disabled = false;
          button.textContent = previousText;
          setStatus('recent-status', error.message || String(error), true);
        }
      }

      // The dashboard polls /local/recent-documents in the background so docs that
      // get created or deleted in another tab/process appear without a manual
      // refresh. The first call (or a manual click on Refresh) flashes a
      // "Loading..." status; background polls keep the list quiet so we don't
      // strobe the status text every few seconds.
      var lastDocumentsSignature = '';
      async function loadRecentDocuments(options) {
        var quiet = !!(options && options.quiet);
        var list = document.getElementById('recent-list');
        if (!list) return;
        if (!quiet) {
          list.innerHTML = '';
          setStatus('recent-status', 'Loading recent drafts...', false);
        }
        try {
          var response = await fetch('/local/recent-documents', { cache: 'no-store' });
          var data = await response.json().catch(function () { return {}; });
          if (!response.ok) {
            throw new Error(data.error || 'Could not load recent drafts');
          }
          var documents = Array.isArray(data.documents) ? data.documents : [];
          // Compute a cheap signature so quiet polls only re-render when
          // something actually changed. Avoids resetting in-flight focus on
          // a Delete button while the user is hovering it.
          var signature = documents.map(function (doc) {
            return (doc.slug || '') + ':' + (doc.revision || 0) + ':' + (doc.updatedAt || '');
          }).join('|');
          if (quiet && signature === lastDocumentsSignature) return;
          lastDocumentsSignature = signature;
          list.innerHTML = '';
          if (documents.length === 0) {
            setStatus('recent-status', 'No drafts yet. Create or import one above.', false);
            return;
          }
          setStatus('recent-status', documents.length + ' recent draft' + (documents.length === 1 ? '' : 's'), false);
          documents.forEach(function (doc) {
            var item = document.createElement('article');
            item.className = 'recent-item';
            item.setAttribute('data-slug', doc.slug || '');
            var copy = document.createElement('div');
            copy.className = 'recent-copy';
            var title = document.createElement('span');
            title.className = 'recent-title';
            title.textContent = doc.title || doc.slug || 'Untitled draft';
            var meta = document.createElement('span');
            meta.className = 'recent-meta';
            meta.textContent = 'rev ' + doc.revision + ' · ' + formatDate(doc.updatedAt);
            copy.appendChild(title);
            copy.appendChild(meta);
            var actions = document.createElement('div');
            actions.className = 'recent-actions';
            var openLink = document.createElement('a');
            openLink.className = 'recent-open';
            openLink.href = doc.url;
            openLink.textContent = 'Open';
            var deleteButton = document.createElement('button');
            deleteButton.type = 'button';
            deleteButton.className = 'danger-button';
            deleteButton.textContent = 'Delete';
            deleteButton.setAttribute('aria-label', 'Delete ' + (doc.title || doc.slug || 'Untitled draft'));
            deleteButton.addEventListener('click', function () {
              deleteRecentDocument(doc, deleteButton);
            });
            actions.appendChild(openLink);
            actions.appendChild(deleteButton);
            item.appendChild(copy);
            item.appendChild(actions);
            list.appendChild(item);
          });
        } catch (error) {
          if (!quiet) {
            setStatus('recent-status', error.message || String(error), true);
          }
        }
      }

      document.getElementById('blank-form').addEventListener('submit', async function (event) {
        event.preventDefault();
        var titleInput = document.getElementById('blank-title');
        var title = titleInput.value.trim() || 'Untitled Proof draft';
        setStatus('blank-status', 'Creating draft...', false);
        try {
          var markdown = '# ' + title + '\\n\\n';
          openCreatedDocument(await createDocument({ title: title, markdown: markdown }));
        } catch (error) {
          setStatus('blank-status', error.message || String(error), true);
        }
      });

      document.getElementById('import-form').addEventListener('submit', async function (event) {
        event.preventDefault();
        var fileInput = document.getElementById('markdown-file');
        var file = fileInput.files && fileInput.files[0];
        if (!file) {
          setStatus('import-status', 'Choose a Markdown file first.', true);
          return;
        }
        setStatus('import-status', 'Importing file...', false);
        try {
          var text = await file.text();
          var title = file.name.replace(/\\.(md|markdown)$/i, '').replace(/[-_]+/g, ' ').trim() || 'Imported Proof draft';
          var markdown = text.trim() ? text : '# ' + title + '\\n\\n';
          openCreatedDocument(await createDocument({ title: title, markdown: markdown }));
        } catch (error) {
          setStatus('import-status', error.message || String(error), true);
        }
      });

      document.getElementById('refresh-recent').addEventListener('click', function () {
        loadRecentDocuments();
      });
      loadRecentDocuments();

      // Background poll: every 5s while the tab is visible, refresh quietly.
      // When the tab is hidden (or the browser throttles it), we pause and do a
      // catch-up fetch on visibilitychange so the list is correct the moment
      // the user looks at it again.
      var POLL_INTERVAL_MS = 5000;
      var pollTimer = null;
      function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(function () {
          loadRecentDocuments({ quiet: true });
        }, POLL_INTERVAL_MS);
      }
      function stopPolling() {
        if (!pollTimer) return;
        clearInterval(pollTimer);
        pollTimer = null;
      }
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible') {
          loadRecentDocuments({ quiet: true });
          startPolling();
        } else {
          stopPolling();
        }
      });
      startPolling();
    </script>
  </body>
</html>`);
  });

  app.get('/local/recent-documents', localDashboardOnly, (_req, res) => {
    const documents = listActiveDocuments()
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
      .slice(0, 30)
      .map((doc) => ({
        slug: doc.slug,
        title: doc.title || 'Untitled draft',
        revision: doc.revision,
        updatedAt: doc.updated_at,
        createdAt: doc.created_at,
        url: `/local/open/${encodeURIComponent(doc.slug)}`,
      }));
    res.json({ documents });
  });

  app.post('/local/documents/:slug/delete', localDashboardOnly, (req, res) => {
    const slug = typeof req.params.slug === 'string' ? req.params.slug.trim() : '';
    if (!slug) {
      res.status(400).json({ success: false, error: 'Invalid slug' });
      return;
    }

    const doc = getDocument(slug);
    if (!doc) {
      res.status(404).json({ success: false, error: 'Proof draft not found' });
      return;
    }
    if (doc.share_state === 'DELETED') {
      res.json({ success: true, slug, shareState: 'DELETED', alreadyDeleted: true });
      return;
    }

    const deleted = deleteDocument(slug);
    if (!deleted) {
      res.status(500).json({ success: false, error: 'Could not delete Proof draft' });
      return;
    }

    revokeDocumentAccessTokens(slug, undefined, { bumpEpoch: false });
    invalidateCollabDocument(slug);
    closeRoom(slug);
    addEvent(slug, 'document.deleted', { source: 'local-dashboard' }, 'local-dashboard');
    res.json({ success: true, slug, shareState: 'DELETED' });
  });

  app.get('/local/open/:slug', localDashboardOnly, (req, res) => {
    const slug = typeof req.params.slug === 'string' ? req.params.slug.trim() : '';
    const doc = slug ? getDocument(slug) : undefined;
    if (!slug || !doc || doc.share_state === 'DELETED') {
      res.status(404).type('text/plain').send('Proof draft not found');
      return;
    }
    const access = createDocumentAccessToken(slug, 'editor');
    res.redirect(302, `/d/${encodeURIComponent(slug)}?token=${encodeURIComponent(access.secret)}`);
  });

  app.get('/health', (_req, res) => {
    const buildInfo = getBuildInfo();
    res.json({
      ok: true,
      buildInfo,
      collab: getCollabRuntime(),
    });
  });

  app.get('/api/capabilities', (_req, res) => {
    res.json(capabilitiesPayload());
  });

  app.use(discoveryRoutes);
  app.use('/api', enforceApiClientCompatibility, apiRoutes);
  app.use('/api/agent', agentRoutes);
  app.use(apiRoutes);
  app.use('/d', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', createBridgeMountRouter(enforceBridgeClientCompatibility));
  app.use('/documents', agentRoutes);
  app.use(shareWebRoutes);

  setupWebSocket(wss);
  await startCollabRuntimeEmbedded(PORT);

  server.listen(PORT, HOST, () => {
    console.log(`[proof-sdk] listening on http://${HOST}:${PORT}`);
    if (HOST === '0.0.0.0' || HOST === '::') {
      console.log('[proof-sdk] WARNING: bound to all interfaces. The /local/* dashboard remains loopback-only unless PROOF_LOCAL_DASHBOARD_REMOTE_HOSTS=1.');
    }
  });
}

main().catch((error) => {
  console.error('[proof-sdk] failed to start server', error);
  process.exit(1);
});
