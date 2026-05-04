# Proof Agent Docs

## Proof SDK Route Alias

Hosted Proof keeps the `/api/agent/*` and `/share/markdown` compatibility routes.

The reusable `Proof SDK` surface is mounted in parallel at:

- `POST /documents`
- `GET /documents/:slug/state`
- `GET /documents/:slug/snapshot`
- `POST /documents/:slug/markdown`
- `POST /documents/:slug/edit/v2`
- `POST /documents/:slug/ops`
- `POST /documents/:slug/presence`
- `GET /documents/:slug/events/pending`
- `POST /documents/:slug/events/ack`
- `GET /documents/:slug/bridge/state`
- `GET /documents/:slug/bridge/marks`
- `POST /documents/:slug/bridge/comments`
- `POST /documents/:slug/bridge/suggestions`
- `POST /documents/:slug/bridge/rewrite`
- `POST /documents/:slug/bridge/presence`

## Which Editing Method Should I Use?

Proof has three editing approaches. **Pick one — don't mix them.**

| Goal | Method | Endpoint |
|------|--------|----------|
| **Insert/append a Markdown memo or section** (recommended for agents) | Markdown import | `POST /markdown` |
| **Add/replace/insert a few lines** (recommended) | Edit V2 (block-level) | `GET /snapshot` → `POST /edit/v2` |
| **Simple text replacement** | Structured edit | `POST /edit` |
| **Replace entire document** | Rewrite | `POST /ops` with `rewrite.apply` |
| **Add a comment** | Ops | `POST /ops` with `comment.add` |

**Start with Markdown import** when you already have Markdown text to add. It accepts a Markdown blob, splits it into top-level blocks, batches large inserts internally, and uses Edit V2 underneath.

**Start with Edit V2** when you need surgical block edits. It uses stable block refs, handles concurrent edits cleanly, and returns clean markdown without internal HTML annotations.

`suggestion.add` now matches against annotated documents correctly and preserves stable anchors, but `edit/v2` is still the better default for programmatic content changes.

`rewrite.apply` is still disruptive. Avoid it if anyone might have the document open: hosted environments block rewrites while live authenticated collaborators are connected, and `force` is ignored there.

## Common Agent Tasks

### Append a Markdown memo

Use this when Adam or Pete says "put this Markdown into the doc" and gives you a draft.

```bash
curl -X POST "http://localhost:4000/documents/<slug>/markdown" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "X-Agent-Id: your-agent" \
  -H "Idempotency-Key: <uuid-or-content-hash>" \
  -d '{
    "by": "ai:your-agent",
    "mode": "append",
    "markdown": "## New Section\n\nDraft text here.\n\n- One\n- Two"
  }'
```

### Insert Markdown after a known block ref

```bash
curl -X POST "http://localhost:4000/documents/<slug>/markdown" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "X-Agent-Id: your-agent" \
  -d '{
    "by": "ai:your-agent",
    "mode": "insert_after_ref",
    "ref": "b12",
    "markdown": "### Inserted Detail\n\nText here."
  }'
```

### Insert Markdown after a heading

```bash
curl -X POST "http://localhost:4000/documents/<slug>/markdown" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "X-Agent-Id: your-agent" \
  -d '{
    "by": "ai:your-agent",
    "mode": "insert_after_heading",
    "heading": "Open Questions",
    "markdown": "- New question from review."
  }'
```

### Replace the current document with Markdown

Use `mode: "replace"` only when a human explicitly asks for a whole-draft replacement. The server applies this as live-safe block mutations instead of `rewrite.apply`.

```bash
curl -X POST "http://localhost:4000/documents/<slug>/markdown" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "X-Agent-Id: your-agent" \
  -d '{"by":"ai:your-agent","mode":"replace","markdown":"# New Draft\n\nBody."}'
```

### Comment on a quote

Use `/ops` for comments, flags, suggestions, accepts, and rejects. Do not use Markdown import for review marks.

## Coexisting With Live-Collab Editors

When a human is actively typing in Proof, your agent write may land in the canonical document store **but lose to live Yjs deltas before it becomes visible** to the human. The server detects this and surfaces it explicitly — but you must check the right field, or you will tell the human "shipped" while the human sees nothing.

### Always check `collabApplied`, not just `success` or HTTP status

Every successful agent edit response (200, 202, or 409 from `/markdown`, `/edit/v2`) returns:

- `success` (top-level boolean) — `true` only when the write reached the live Yjs state visible to humans. **Treat any other value as a failed write.**
- `collabApplied` (top-level boolean) — same semantics, hoisted alongside `success` so you cannot miss it.
- `code` — `'LIVE_COLLAB_DIVERGED'` when the canonical write happened but Yjs did not converge before another writer changed the document.
- `collab.status` — `'confirmed'` when the live state agrees, `'pending'` when it does not.

Historically the server returned `success: true` with `collab.status: 'pending'` on divergence, which led to agents reporting "shipped" while the human saw nothing. **That cannot happen anymore** — but if you are talking to an older server build, treat `collab.status !== 'confirmed'` as a failed write regardless of `success`.

### Default behavior: soft fail with HTTP 202

Without an opt-in flag, divergence returns:

```json
HTTP/1.1 202 Accepted
{
  "success": false,
  "collabApplied": false,
  "code": "LIVE_COLLAB_DIVERGED",
  "error": "The agent write reached the canonical document store but the live Yjs state did not converge before another writer changed the document. Re-anchor against the latest snapshot and retry.",
  "divergenceReason": "canonical_changed_during_fallback",
  "hint": "Pass `canonical_required: true` to fail-fast on this race instead of receiving HTTP 202.",
  "collab": { "status": "pending", ... }
}
```

The 202 is intentional — the canonical store DID accept the write — but `success: false` tells you the operationally meaningful outcome.

### Opt-in: hard fail with HTTP 409

If your agent reports outcomes to a human, set `canonical_required: true` on the request. Divergence then returns HTTP 409 instead of 202, so a status-code-based check (`if (response.ok)`) also catches the race:

```bash
curl -X POST "http://localhost:4000/documents/<slug>/markdown" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -H "X-Agent-Id: your-agent" \
  -d '{
    "by":"ai:your-agent",
    "mode":"insert_after_ref",
    "ref":"b3",
    "markdown":"## New Section\n\nDraft text.",
    "canonical_required": true
  }'
```

Use this for any agent that reports back to a human, runs in a CI/CD-style pipeline, or composes multi-step changes that depend on the prior step actually landing.

### Detecting superseded writes via the event log

When a write diverges, the server emits an `agent.edit.superseded` event into the document's event log. Polling agents can detect that a previously accepted write was lost without diffing markdown:

```bash
curl "http://localhost:4000/documents/<slug>/events/pending?after=<lastEventId>" \
  -H "Authorization: Bearer <token>"
```

The event payload includes `by`, `divergenceReason`, `canonicalRequired`, `expectedMarkdownHead`, and `expectedMarkdownHash` so you can identify your own superseded writes.

### Recommended pattern

```js
const response = await fetch(markdownUrl, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ by: agentId, mode: 'insert_after_ref', ref: anchorRef, markdown, canonical_required: true }),
});
const body = await response.json();
if (!body.success || !body.collabApplied) {
  // Re-fetch /state, re-anchor, retry once. If divergence repeats, surface the
  // race to the human ("Pete is editing — try again in a moment") instead of
  // claiming the write succeeded.
  throw new Error(`Agent write did not converge: ${body.code} (${body.divergenceReason ?? 'unknown'})`);
}
```

## I Just Received A Proof Link

No browser automation is required. Use HTTP directly (for example, `curl` or your tool's `web_fetch`).

If you received a shared link like:

  http://localhost:4000/d/<slug>?token=<token>

You can discover the API and read the document in one step using **content negotiation** on that same URL.

Fetch JSON (recommended):

  curl -H "Accept: application/json" "http://localhost:4000/d/<slug>?token=<token>"

Fetch raw markdown:

  curl -H "Accept: text/markdown" "http://localhost:4000/d/<slug>?token=<token>"

The JSON response includes:
- `markdown` (document content)
- `_links` (state, ops, docs)
- `agent.auth` hints (how to use the token)

### Quick copy/paste flow (token already in the shared URL)

```bash
SHARE_URL='http://localhost:4000/d/<slug>?token=<token>'
TOKEN='<token>'
SLUG='<slug>'

curl -H "Accept: application/json" "$SHARE_URL"
curl -H "Accept: text/markdown" "$SHARE_URL"
curl -H "Authorization: Bearer $TOKEN" -H "X-Agent-Id: your-agent" "http://localhost:4000/documents/$SLUG/state"
```

## Auth: Token From URL

If a URL contains `?token=`, treat it as an access token:

- Preferred: `Authorization: Bearer <token>`
- Also accepted: `x-share-token: <token>`

## Edit Via Ops (Comments, Suggestions, Rewrite)

Use:

  POST /documents/<slug>/ops

`by` controls authorship. Presence is explicit-only: send `X-Agent-Id: <your-agent-id>` (or `agentId` in the JSON body) when you want the agent to appear in presence.

Add a comment:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"comment.add","by":"ai:your-agent","quote":"text to anchor","text":"comment body"}'

Suggest a replace:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"suggestion.add","by":"ai:your-agent","kind":"replace","quote":"old text","content":"new text"}'

Create and immediately apply a suggestion:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"suggestion.add","by":"ai:your-agent","kind":"replace","quote":"old text","content":"new text","status":"accepted"}'

Rewrite the whole document:

  curl -X POST "http://localhost:4000/documents/<slug>/ops?token=<token>" \
    -H "Content-Type: application/json" \
    -H "X-Agent-Id: your-agent" \
    -d '{"type":"rewrite.apply","by":"ai:your-agent","content":"# New markdown..."}'

## Edit Via Structured Operations (Append, Replace, Insert)

For surgical edits without rewriting the entire document, use the `/edit` endpoint:

  POST /documents/<slug>/edit

All requests require `Content-Type: application/json` and auth via `Authorization: Bearer <token>`.

The body must include an `operations` array (max 50 ops) and a `by` field for authorship. If you want presence, also send `X-Agent-Id: <your-agent-id>` or `agentId` in the body.

### Append to a section

Add content at the end of a named section (matched by heading text):

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "append", "section": "Brandon", "content": "\n\n**Feb 16, 2026**\n\nNew brainstorm idea here."}
      ]
    }'

The `section` value is matched against heading text (e.g., `"Brandon"` matches `### Brandon`).

### Replace text

Find and replace a specific string in the document:

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "replace", "search": "old text to find", "content": "new replacement text"}
      ]
    }'

### Insert after text

Insert content after a specific anchor string:

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "insert", "after": "anchor text to find", "content": "\n\nContent to insert after the anchor."}
      ]
    }'

`insert` only supports `after`. Payloads using `before` are rejected with `INVALID_OPERATIONS`.

### Multiple operations

You can combine operations in a single request (applied in order):

  curl -X POST "http://localhost:4000/documents/<slug>/edit" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "X-Agent-Id: your-agent" \
    -d '{
      "by": "ai:your-agent",
      "operations": [
        {"op": "append", "section": "Dan", "content": "\n\nNew idea from Dan."},
        {"op": "replace", "search": "(placeholder)", "content": "Actual content here."}
      ]
    }'

### Response

A successful response includes:

  {
    "success": true,
    "slug": "<slug>",
    "updatedAt": "<ISO timestamp>",
    "collabApplied": true
  }

- `collabApplied: true` means the edit was pushed into the live collab session (connected viewers see it in real time).
- `presenceApplied` is only `true` when you also supplied explicit agent identity via `X-Agent-Id`, `agentId`, or `agent.id`.
- If the document changed since you last read it, you may get a `409 STALE_BASE` error — re-fetch state and retry.

Collab convergence fields:
- `collab.status` is render-authoritative (`confirmed` when the ProseMirror/Yjs fragment converged).
- `collab.fragmentStatus` tracks fragment convergence (`confirmed|pending`).
- `collab.markdownStatus` tracks SQL markdown projection convergence (`confirmed|pending`).
- `collabApplied` follows `fragmentStatus` (not markdown projection status).

### Optimistic locking (required for `/edit`)

Pass `baseUpdatedAt` (from a prior state response) to detect concurrent edits:

  {"by": "ai:your-agent", "baseUpdatedAt": "2026-02-16T...", "operations": [...]}

If the document's `updatedAt` doesn't match, you'll get a `409` with `retryWithState` pointing to the state endpoint.

## Update Title Metadata

Use:

  PUT /documents/<slug>/title

Example:

  curl -X PUT "http://localhost:4000/documents/<slug>/title" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -d '{"title":"Updated document title"}'

Discovery:
- `GET /documents/<slug>/state` includes `_links.title` and `agent.titleApi`.

## Edit V2 (Block IDs + Revision Locking)

Use v2 for top-level block edits with stable block IDs and revision-based optimistic locking.

### What counts as one block?

Edit V2 operations require each `block.markdown` or `blocks[].markdown` entry to parse into exactly one top-level Markdown node.

Accepted as one block:
- A single heading: `### Heading`
- One paragraph
- One multi-item list
- One multi-row table
- One fenced code block

Not accepted as one block:
- `### Heading\n\nParagraph` because that is a heading plus a paragraph.
- Two paragraphs separated by a blank line.
- A heading followed by a list.

If your content has multiple top-level nodes, use `POST /documents/<slug>/markdown`; it auto-splits the Markdown for you.

### Get a snapshot

  GET /documents/<slug>/snapshot

Example:

  curl -H "Authorization: Bearer <token>" "http://localhost:4000/documents/<slug>/snapshot"

The response includes `revision` and an ordered `blocks` array with deterministic refs (`b1`, `b2`, ...).

### Apply edits

  POST /documents/<slug>/edit/v2

Example:

  curl -X POST "http://localhost:4000/documents/<slug>/edit/v2" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "Idempotency-Key: <uuid>" \
    -d '{
      "by": "ai:your-agent",
      "baseRevision": 128,
      "operations": [
        { "op": "replace_block", "ref": "b3", "block": { "markdown": "Updated paragraph." } },
        { "op": "insert_after", "ref": "b3", "blocks": [{ "markdown": "## New Section" }] },
        { "op": "append", "blocks": [{ "markdown": "Final paragraph." }] }
      ]
    }'

On success, the response includes the new `revision`, a `snapshot` payload, and a `collab` status.
If your `baseRevision` is stale, you'll receive `STALE_REVISION` plus the latest snapshot for retry.

v2 convergence fields:
- `collab.status` remains compatibility status (`confirmed|pending`) and is fragment-authoritative.
- `collab.fragmentStatus` and `collab.markdownStatus` expose render-vs-projection split directly.
- `202` is only expected when fragment convergence is pending.

Precondition contract for v2:
- `baseRevision` is required.
- `baseUpdatedAt` is not accepted on `/edit/v2`.

Idempotency guidance:
- Send `Idempotency-Key` for mutation requests (`X-Idempotency-Key` is also accepted for compatibility).
- `/edit/v2` examples include this header because block-level retries are common in automation.

Mutation contract discovery:
- Read `contract.mutationStage` from `GET /documents/<slug>/state` to detect Stage A/B/C rollout.
- `contract.idempotencyRequired` and `contract.preconditionMode` summarize current requirements.
- `capabilities.mutationLimits` exposes practical limits: max operations, max blocks per mutation, max bytes per block, and Markdown import batch sizing.

Stage meanings:
- Stage A: preconditions are optional for older mutation routes, but Edit V2 still requires `baseRevision` or `baseToken` unless `/markdown` is handling the base internally.
- Stage B: mutation requests require a precondition (`baseRevision` or `baseUpdatedAt` depending on route).
- Stage C: mutation requests require `baseRevision`; idempotency may also be required.

Common mutation contract error codes:
- `IDEMPOTENCY_KEY_REQUIRED`: mutation request omitted idempotency key in required stage.
- `IDEMPOTENCY_KEY_REUSED`: same key reused with a different payload hash.
- `BASE_REVISION_REQUIRED`: stage requires `baseRevision` and request did not provide it.
- `LIVE_CLIENTS_PRESENT`: rewrite blocked because active authenticated collab clients are connected.
  Use `retryWithState` to refresh state, confirm `connectedClients === 0`, and if `forceIgnored=true` do not retry with `force` in hosted environments.
  This response is retryable and includes `reason` + `nextSteps`.
- `REWRITE_BARRIER_FAILED`: rewrite safety barrier failed before mutation; no rewrite was applied.
  This response is retryable and includes `reason` + `nextSteps`; retry with bounded exponential backoff and jitter.

## Presence And Event Polling

Poll for changes:

  GET /documents/<slug>/events/pending?after=<cursor>&limit=100

Ack processed events (editor/owner):

  POST /documents/<slug>/events/ack
  Body: {"upToId": <cursor>, "by": "ai:your-agent"}

## Archived Desktop Workflow

This repo is web-first. Desktop-native workflows are outside the public SDK scope and should be treated as separate implementation work.

## Projection Guardrails And QA

Operational metrics:
- `projection_guard_block_total{reason,source}`
- `projection_drift_total{reason,source}`
- `projection_repair_total{result,reason}`
- `projection_chars_bucket{source,le}`

Staging soak (live browser viewers + repeated `/edit` + `/edit/v2`):

  SHARE_BASE_URL=https://proof-web-staging.up.railway.app \
  SOAK_DURATION_MS=300000 \
  npx tsx scripts/staging-collab-projection-soak.ts

## Create A New Shared Doc

If you need to create a share from scratch, use:

  POST /documents

This is the canonical public create route.
Hosted Proof still accepts `POST /share/markdown` as a compatibility alias.
Legacy create routes like `/api/documents` are internal/legacy and may be warned or disabled on hosted environments.

## Recommended Workflow: Adding Content To An Existing Doc

If you already have Markdown to insert, use `POST /documents/<slug>/markdown` first. It handles snapshot/base selection, top-level splitting, batching, and block insertion.

Use the lower-level Edit V2 workflow when you need to inspect nearby blocks before making a surgical edit:

### Step 1: Get the snapshot

  curl -H "Authorization: Bearer <token>" "http://localhost:4000/documents/<slug>/snapshot"

This returns clean markdown per block (no internal HTML tags) plus stable `ref` identifiers and a `revision` number.
### Step 2: Find the right block

Look through the `blocks` array for the block you want to edit or insert near. Each block has:
- `ref`: stable identifier (e.g., `b3`)
- `markdown`: the clean markdown content of that block
- `type`: block type (e.g., `paragraph`, `heading`, `table`)

### Step 3: Apply your edit

  curl -X POST "http://localhost:4000/documents/<slug>/edit/v2" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer <token>" \
    -H "Idempotency-Key: <uuid>" \
    -d '{
      "by": "ai:your-agent",
      "baseRevision": 128,
      "operations": [
        { "op": "insert_after", "ref": "b3", "blocks": [{ "markdown": "New content here." }] }
      ]
    }'

### Step 4: Handle conflicts

If you get `STALE_REVISION`, the response includes the latest snapshot — re-read the blocks and retry.

## Troubleshooting

### `ANCHOR_NOT_FOUND` on `/edit` replace or insert

The `/edit` endpoint searches for your `search` or `after` text in the document. If the document was previously edited by agents, it may contain internal `<span data-proof="authored">` HTML tags. The search now automatically falls back to matching against clean text (with tags stripped), so this should be rare. If it still fails, the text genuinely doesn't exist in the document — re-read state and verify.

### `LIVE_CLIENTS_PRESENT` on `rewrite.apply`

`rewrite.apply` is blocked when authenticated collaborators are connected. Outside hosted environments you can pass `"force": true`, but on hosted environments `force` is ignored. If you still prefer the safer path:
1. Use `/edit` or `/edit/v2` instead (they work with live clients).
2. Wait for clients to disconnect (poll `/state` and check `connectedClients`).

### Suggestion anchors not matching

`suggestion.add` now resolves quotes against clean text even when the stored markdown contains internal `<span data-proof="authored">` annotations. If you still get `ANCHOR_NOT_FOUND`, re-read state and verify the quote text genuinely exists.

### Document content looks corrupted after suggestion reject cycles

Repeated suggest/reject cycles on annotated documents now preserve stable suggestion anchors so the document text should remain unchanged. If you still see unexpected content drift, re-read `Accept: text/markdown` and report the exact request/response pair.

### `COLLAB_SYNC_FAILED` errors

Edits via the API can fail when a browser has the document open with an active Yjs collab session. The `/edit` and `/edit/v2` endpoints handle this gracefully, but `rewrite.apply` does not. If you hit this, retry after a short delay or use `/edit`/`/edit/v2` instead.
