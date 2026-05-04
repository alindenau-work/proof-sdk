import { createHash } from 'crypto';
import {
  AGENT_MARKDOWN_IMPORT_BATCH_BLOCKS,
  AGENT_MARKDOWN_IMPORT_MAX_BYTES,
} from './agent-edit-limits.js';
import { applyAgentEditV2, type AgentEditV2Result } from './agent-edit-v2.js';
import { buildAgentSnapshot } from './agent-snapshot.js';
import {
  getHeadlessMilkdownParser,
  parseMarkdownWithHtmlFallback,
  serializeSingleNode,
  summarizeParseError,
} from './milkdown-headless.js';

type MarkdownImportMode =
  | 'append'
  | 'replace'
  | 'insert_after_ref'
  | 'insert_before_ref'
  | 'insert_after_heading';

type MarkdownBlock = {
  markdown: string;
};

type SnapshotBlock = {
  ref: string;
  type?: string;
  markdown?: string;
  textPreview?: string;
  level?: number;
};

type MarkdownImportRequest = {
  mode: MarkdownImportMode;
  markdown: string;
  by: string;
  ref?: string;
  heading?: string;
  occurrence: 'first' | 'last' | number;
  baseToken?: string;
  baseRevision?: number;
  /**
   * When true, divergence between canonical and live Yjs returns HTTP 409 +
   * LIVE_COLLAB_DIVERGED instead of the soft-fail 202. See applyDivergenceShape
   * in agent-edit-v2.ts for full semantics.
   */
  canonicalRequired: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function hashMarkdown(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

function parseRefIndex(ref: string): number | null {
  const match = ref.match(/^b(\d+)$/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeHeadingText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseRequest(body: unknown): { ok: true; request: MarkdownImportRequest } | { ok: false; status: number; body: Record<string, unknown> } {
  const payload = isRecord(body) ? body : {};
  const rawMarkdown = payload.markdown ?? payload.content;
  if (typeof rawMarkdown !== 'string') {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        code: 'INVALID_MARKDOWN_REQUEST',
        error: `markdown must be a string, got ${describeType(rawMarkdown)}`,
        path: 'markdown',
        expected: 'string',
        actual: describeType(rawMarkdown),
      },
    };
  }

  const bytes = Buffer.byteLength(rawMarkdown, 'utf8');
  if (bytes > AGENT_MARKDOWN_IMPORT_MAX_BYTES) {
    return {
      ok: false,
      status: 413,
      body: {
        success: false,
        code: 'REQUEST_TOO_LARGE',
        error: 'Markdown import is too large',
        path: 'markdown',
        limit: AGENT_MARKDOWN_IMPORT_MAX_BYTES,
        actualBytes: bytes,
      },
    };
  }

  const rawMode = typeof payload.mode === 'string'
    ? payload.mode
    : typeof payload.position === 'string'
      ? payload.position
      : typeof payload.op === 'string'
        ? payload.op
        : 'append';
  const modeAliases: Record<string, MarkdownImportMode> = {
    append: 'append',
    replace: 'replace',
    replace_document: 'replace',
    insert_after_ref: 'insert_after_ref',
    insert_after: 'insert_after_ref',
    insert_before_ref: 'insert_before_ref',
    insert_before: 'insert_before_ref',
    insert_after_heading: 'insert_after_heading',
    after_heading: 'insert_after_heading',
  };
  const mode = modeAliases[rawMode.trim().toLowerCase()];
  if (!mode) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        code: 'INVALID_MARKDOWN_MODE',
        error: 'mode must be append, replace, insert_after_ref, insert_before_ref, or insert_after_heading',
        path: 'mode',
        actual: rawMode,
      },
    };
  }

  const ref = typeof payload.ref === 'string' && payload.ref.trim() ? payload.ref.trim() : undefined;
  if ((mode === 'insert_after_ref' || mode === 'insert_before_ref') && !ref) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        code: 'INVALID_MARKDOWN_TARGET',
        error: `${mode} requires ref`,
        path: 'ref',
        expected: 'block ref like b3',
      },
    };
  }

  const heading = typeof payload.heading === 'string' && payload.heading.trim()
    ? payload.heading.trim()
    : typeof payload.afterHeading === 'string' && payload.afterHeading.trim()
      ? payload.afterHeading.trim()
      : undefined;
  if (mode === 'insert_after_heading' && !heading) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        code: 'INVALID_MARKDOWN_TARGET',
        error: 'insert_after_heading requires heading',
        path: 'heading',
        expected: 'heading text',
      },
    };
  }

  const rawOccurrence = payload.occurrence;
  const occurrence = rawOccurrence === 'last'
    ? 'last'
    : Number.isInteger(rawOccurrence) && Number(rawOccurrence) >= 0
      ? Number(rawOccurrence)
      : 'first';

  const canonicalRequiredRaw = payload.canonical_required ?? payload.canonicalRequired;
  const canonicalRequired = canonicalRequiredRaw === true || canonicalRequiredRaw === 'true';

  const request: MarkdownImportRequest = {
    mode,
    markdown: rawMarkdown,
    by: typeof payload.by === 'string' && payload.by.trim() ? payload.by.trim() : 'ai:unknown',
    occurrence,
    canonicalRequired,
    ...(ref ? { ref } : {}),
    ...(heading ? { heading } : {}),
  };

  if (typeof payload.baseToken === 'string' && payload.baseToken.trim()) {
    request.baseToken = payload.baseToken.trim();
  } else if (Number.isInteger(payload.baseRevision) && Number(payload.baseRevision) > 0) {
    request.baseRevision = Number(payload.baseRevision);
  }

  return { ok: true, request };
}

async function splitMarkdownIntoBlocks(markdown: string): Promise<
  { ok: true; blocks: MarkdownBlock[] }
  | { ok: false; status: number; body: Record<string, unknown> }
> {
  const parser = await getHeadlessMilkdownParser();
  const parsed = parseMarkdownWithHtmlFallback(parser, markdown);
  if (!parsed.doc) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        code: 'INVALID_MARKDOWN',
        error: summarizeParseError(parsed.error),
        path: 'markdown',
      },
    };
  }

  const blocks: MarkdownBlock[] = [];
  for (let i = 0; i < parsed.doc.childCount; i += 1) {
    blocks.push({ markdown: await serializeSingleNode(parsed.doc.child(i)) });
  }
  if (blocks.length === 0) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        code: 'INVALID_MARKDOWN',
        error: 'markdown produced no top-level blocks',
        path: 'markdown',
      },
    };
  }
  return { ok: true, blocks };
}

function snapshotBlocks(snapshot: Record<string, unknown>): SnapshotBlock[] {
  const rawBlocks = Array.isArray(snapshot.blocks) ? snapshot.blocks : [];
  return rawBlocks.flatMap((block): SnapshotBlock[] => {
    if (!isRecord(block) || typeof block.ref !== 'string') return [];
    return [{
      ref: block.ref,
      ...(typeof block.type === 'string' ? { type: block.type } : {}),
      ...(typeof block.markdown === 'string' ? { markdown: block.markdown } : {}),
      ...(typeof block.textPreview === 'string' ? { textPreview: block.textPreview } : {}),
      ...(typeof block.level === 'number' ? { level: block.level } : {}),
    }];
  });
}

function baseFromSnapshot(snapshot: Record<string, unknown>): { baseToken: string } | { baseRevision: number } | null {
  const mutationBase = isRecord(snapshot.mutationBase) ? snapshot.mutationBase : null;
  if (typeof mutationBase?.token === 'string' && mutationBase.token.trim()) {
    return { baseToken: mutationBase.token.trim() };
  }
  if (typeof snapshot.revision === 'number' && Number.isInteger(snapshot.revision) && snapshot.revision > 0) {
    return { baseRevision: snapshot.revision };
  }
  return null;
}

function findHeadingRef(blocks: SnapshotBlock[], heading: string, occurrence: MarkdownImportRequest['occurrence']): string | null {
  const normalized = normalizeHeadingText(heading);
  const matches = blocks.filter((block) => {
    if (block.type !== 'heading') return false;
    const text = block.textPreview ?? block.markdown ?? '';
    return normalizeHeadingText(text) === normalized;
  });
  if (matches.length === 0) return null;
  if (occurrence === 'last') return matches[matches.length - 1]?.ref ?? null;
  if (typeof occurrence === 'number') return matches[occurrence]?.ref ?? null;
  return matches[0]?.ref ?? null;
}

function buildInitialOperation(
  request: MarkdownImportRequest,
  blocks: SnapshotBlock[],
  chunk: MarkdownBlock[],
): { ok: true; operation: Record<string, unknown>; insertedAfterRef?: string; followupMode: 'append' | 'insert_after_ref' }
  | { ok: false; status: number; body: Record<string, unknown> } {
  if (request.mode === 'append') {
    return { ok: true, operation: { op: 'append', blocks: chunk }, followupMode: 'append' };
  }

  if (request.mode === 'replace') {
    if (blocks.length === 0) {
      return { ok: true, operation: { op: 'append', blocks: chunk }, followupMode: 'append' };
    }
    return {
      ok: true,
      operation: {
        op: 'replace_range',
        fromRef: blocks[0]?.ref,
        toRef: blocks[blocks.length - 1]?.ref,
        blocks: chunk,
      },
      insertedAfterRef: chunk.length > 0 ? `b${chunk.length}` : undefined,
      followupMode: 'append',
    };
  }

  const ref = request.mode === 'insert_after_heading'
    ? findHeadingRef(blocks, request.heading ?? '', request.occurrence)
    : request.ref;
  if (!ref) {
    return {
      ok: false,
      status: 404,
      body: {
        success: false,
        code: 'MARKDOWN_TARGET_NOT_FOUND',
        error: request.mode === 'insert_after_heading'
          ? `Heading not found: ${request.heading ?? ''}`
          : 'Target ref not found',
        ...(request.mode === 'insert_after_heading' ? { heading: request.heading ?? '' } : { ref: request.ref ?? null }),
      },
    };
  }

  const refIndex = parseRefIndex(ref);
  if (refIndex === null) {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        code: 'INVALID_MARKDOWN_TARGET',
        error: 'ref must be a block ref like b3',
        path: 'ref',
        actual: ref,
      },
    };
  }
  if (!blocks.some((block) => block.ref.toLowerCase() === ref.toLowerCase())) {
    return {
      ok: false,
      status: 404,
      body: {
        success: false,
        code: 'MARKDOWN_TARGET_NOT_FOUND',
        error: `Target ref not found: ${ref}`,
        ref,
      },
    };
  }

  if (request.mode === 'insert_before_ref') {
    return {
      ok: true,
      operation: { op: 'insert_before', ref, blocks: chunk },
      insertedAfterRef: `b${Math.max(1, refIndex - 1 + chunk.length)}`,
      followupMode: 'insert_after_ref',
    };
  }

  return {
    ok: true,
    operation: { op: 'insert_after', ref, blocks: chunk },
    insertedAfterRef: `b${refIndex + chunk.length}`,
    followupMode: 'insert_after_ref',
  };
}

function buildFollowupOperation(
  followupMode: 'append' | 'insert_after_ref',
  insertedAfterRef: string | undefined,
  chunk: MarkdownBlock[],
): { operation: Record<string, unknown>; insertedAfterRef?: string } {
  if (followupMode === 'append' || !insertedAfterRef) {
    return { operation: { op: 'append', blocks: chunk } };
  }
  const refIndex = parseRefIndex(insertedAfterRef) ?? 0;
  return {
    operation: { op: 'insert_after', ref: insertedAfterRef, blocks: chunk },
    insertedAfterRef: `b${refIndex + chunk.length}`,
  };
}

function successBody(
  slug: string,
  request: MarkdownImportRequest,
  blocks: MarkdownBlock[],
  responses: AgentEditV2Result[],
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> {
  const last = responses[responses.length - 1];
  const lastBody = isRecord(last?.body) ? last.body : {};
  // success at the /markdown layer means: every batch landed AND the live Yjs
  // state agrees with what we wrote. The early-return branch in performImport
  // already prevents us from reaching this body when any batch diverged, so
  // both checks should be true here — we recompute defensively in case the
  // underlying /edit/v2 shape changes again.
  const lastCollab = isRecord(lastBody.collab) ? lastBody.collab : undefined;
  const collabApplied = lastBody.collabApplied === true || lastCollab?.status === 'confirmed';
  return {
    success: collabApplied,
    collabApplied,
    slug,
    mode: request.mode,
    importedBlocks: blocks.length,
    batchCount: responses.length,
    contentHash: hashMarkdown(request.markdown),
    idempotencyHint: `markdown:${hashMarkdown(request.markdown)}`,
    revision: typeof lastBody.revision === 'number'
      ? lastBody.revision
      : (snapshot && typeof snapshot.revision === 'number' ? snapshot.revision : null),
    collab: lastCollab,
    snapshot: snapshot ?? (isRecord(lastBody.snapshot) ? lastBody.snapshot : undefined),
    _links: {
      state: `/api/agent/${slug}/state`,
      snapshot: `/api/agent/${slug}/snapshot`,
      markdown: { method: 'POST', href: `/api/agent/${slug}/markdown` },
      editV2: { method: 'POST', href: `/api/agent/${slug}/edit/v2` },
      docs: '/agent-docs',
    },
    agent: {
      docs: '/agent-docs',
      markdownApi: `/api/agent/${slug}/markdown`,
      stateApi: `/api/agent/${slug}/state`,
      snapshotApi: `/api/agent/${slug}/snapshot`,
      editV2Api: `/api/agent/${slug}/edit/v2`,
    },
  };
}

export async function applyAgentMarkdownImport(slug: string, body: unknown): Promise<AgentEditV2Result> {
  const parsedRequest = parseRequest(body);
  if (!parsedRequest.ok) return { status: parsedRequest.status, body: parsedRequest.body };

  const request = parsedRequest.request;
  const parsedMarkdown = await splitMarkdownIntoBlocks(request.markdown);
  if (!parsedMarkdown.ok) return { status: parsedMarkdown.status, body: parsedMarkdown.body };

  const blocks = parsedMarkdown.blocks;
  const initialSnapshotResult = await buildAgentSnapshot(slug);
  if (initialSnapshotResult.status < 200 || initialSnapshotResult.status >= 300) {
    return initialSnapshotResult;
  }

  let snapshot = initialSnapshotResult.body;
  const currentBlocks = snapshotBlocks(snapshot);
  const chunks: MarkdownBlock[][] = [];
  for (let i = 0; i < blocks.length; i += AGENT_MARKDOWN_IMPORT_BATCH_BLOCKS) {
    chunks.push(blocks.slice(i, i + AGENT_MARKDOWN_IMPORT_BATCH_BLOCKS));
  }

  const responses: AgentEditV2Result[] = [];
  let followupMode: 'append' | 'insert_after_ref' = 'append';
  let insertedAfterRef: string | undefined;

  for (let batchIndex = 0; batchIndex < chunks.length; batchIndex += 1) {
    const chunk = chunks[batchIndex];
    const operation = batchIndex === 0
      ? buildInitialOperation(request, currentBlocks, chunk)
      : { ok: true as const, ...buildFollowupOperation(followupMode, insertedAfterRef, chunk), followupMode };
    if (!operation.ok) return { status: operation.status, body: operation.body };

    followupMode = operation.followupMode;
    insertedAfterRef = operation.insertedAfterRef;

    const base = batchIndex === 0 && request.baseToken
      ? { baseToken: request.baseToken }
      : batchIndex === 0 && request.baseRevision
        ? { baseRevision: request.baseRevision }
        : baseFromSnapshot(snapshot);
    if (!base) {
      return {
        status: 409,
        body: {
          success: false,
          code: 'AUTHORITATIVE_BASE_UNAVAILABLE',
          error: 'Could not determine a safe mutation base; retry with latest state',
          retryWithState: `/api/agent/${slug}/state`,
        },
      };
    }

    const result = await applyAgentEditV2(slug, {
      by: request.by,
      ...base,
      operations: [operation.operation],
      // Propagate the markdown caller's atomicity preference. Without this,
      // /markdown imports would silently soft-fail on divergence even when the
      // caller explicitly opted into hard-fail at the /markdown layer.
      canonical_required: request.canonicalRequired,
    });
    responses.push(result);
    if (result.status < 200 || result.status >= 300 || !isRecord(result.body) || result.body.success !== true) {
      return {
        status: result.status,
        body: {
          ...(isRecord(result.body) ? result.body : { success: false, error: 'Markdown import batch failed' }),
          batchIndex,
          importedBlocksBeforeFailure: batchIndex * AGENT_MARKDOWN_IMPORT_BATCH_BLOCKS,
          hint: isRecord(result.body) && typeof result.body.hint === 'string'
            ? result.body.hint
            : 'Refresh /state or /snapshot and retry the Markdown import once.',
        },
      };
    }

    const resultSnapshot = isRecord(result.body.snapshot) ? result.body.snapshot : null;
    snapshot = resultSnapshot ?? (await buildAgentSnapshot(slug)).body;
  }

  return {
    status: responses.some((response) => response.status === 202) ? 202 : 200,
    body: successBody(slug, request, blocks, responses, snapshot),
  };
}
