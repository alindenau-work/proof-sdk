import { readFileSync } from 'node:fs';
import path from 'node:path';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`private ${name}(`);
  assert(start >= 0, `Expected ${name} to exist`);
  const nextMarker = source.indexOf('\n  private ', start + 1);
  return nextMarker >= 0 ? source.slice(start, nextMarker) : source.slice(start);
}

function run(): void {
  const editorPath = path.resolve(process.cwd(), 'src', 'editor', 'index.ts');
  const source = readFileSync(editorPath, 'utf8');
  const stabilizer = extractFunction(source, 'stabilizeCursorAfterRemoteYjsTransaction');
  const selectionCapture = extractFunction(source, 'captureLocalSelectionSnapshot');
  const pendingRebindCapture = extractFunction(source, 'capturePendingCollabRebindSelection');
  const pendingRebindRestore = extractFunction(source, 'restorePendingCollabRebindSelection');
  const stableSelectionResolver = extractFunction(source, 'resolveStableLocalSelection');
  const remoteSelectionRestore = extractFunction(source, 'shouldRestoreLocalSelectionAfterRemoteChange');
  const systemTransactionDetector = extractFunction(source, 'isCursorDisplacingSystemTransaction');
  const systemTransactionStabilizer = extractFunction(source, 'stabilizeCursorAfterSystemTransaction');
  const unexpectedSnapStabilizer = extractFunction(source, 'stabilizeCursorAfterUnexpectedSelectionSnap');
  const inlineCursorGate = extractFunction(source, 'shouldInstallInlineCollabCursors');
  const inlineCursorInstaller = extractFunction(source, 'installCollabCursorsWhenReady');
  const cursorTracking = extractFunction(source, 'setupCursorTracking');

  assert(
    stabilizer.includes('if (!localSelectionOwnedBeforeDispatch) return;'),
    'Expected cursor stabilizer to preserve the locally owned caret even when browser focus flickers',
  );
  assert(
    source.includes('const localSelectionOwnedBeforeDispatch = hadFocusBeforeDispatch || this.hasRecentLocalSelectionActivity();'),
    'Expected remote cursor repair to use explicit local selection ownership, not focus alone',
  );
  assert(
    source.includes('localSelectionOwnershipWindowMs'),
    'Expected local cursor ownership to have a bounded recency window',
  );
  assert(
    cursorTracking.includes("dom.addEventListener('pointerdown', rememberPointerDown)") && cursorTracking.includes("dom.addEventListener('focusin', reportCursor)"),
    'Expected mouse/focus caret activity to establish local cursor ownership before remote edits arrive',
  );
  assert(
    cursorTracking.includes('view.posAtCoords(point)') && cursorTracking.includes("setMeta('proof-local-pointer-selection', true)"),
    'Expected local pointer clicks to be mapped explicitly into ProseMirror cursor positions',
  );
  assert(
    source.includes("inlineCollabCursorsLocalStorageKey = 'proof:collab:inline-cursors'")
      && inlineCursorGate.includes("window.localStorage.getItem(this.inlineCollabCursorsLocalStorageKey) === '1'"),
    'Expected inline remote cursor decorations to be opt-in so remote presence cannot destabilize human carets by default',
  );
  assert(
    inlineCursorInstaller.includes('if (!this.shouldInstallInlineCollabCursors()) return;'),
    'Expected y-prosemirror cursor plugin installation to stay disabled unless explicitly opted in',
  );
  assert(
    cursorTracking.includes("target.closest('[data-mark-id], [contenteditable=\"false\"")
      && cursorTracking.includes('document.elementFromPoint(event.clientX, event.clientY)'),
    'Expected pointer-caret repair to ignore comment/suggestion marks and stale coordinates before forcing a caret',
  );
  assert(
    cursorTracking.includes('!$pos.parent.isTextblock') && cursorTracking.includes('TextSelection.create(view.state.doc, resolved.pos)'),
    'Expected pointer-caret repair to refuse document-level coordinates instead of snapping to a nearby line',
  );
  assert(
    cursorTracking.includes('!domSelection.isCollapsed') && cursorTracking.includes('dx > 5 || dy > 5'),
    'Expected pointer-caret repair not to break drag text selection',
  );
  assert(
    source.includes('private noteLocalSelectionActivity()') && source.includes('private hasRecentLocalSelectionActivity()'),
    'Expected local selection ownership helpers to exist',
  );
  assert(
    source.includes('pendingCollabRebindSelectionSnapshot'),
    'Expected collab rebind/reset paths to preserve the active local cursor snapshot',
  );
  assert(
    pendingRebindCapture.includes('this.captureLocalSelectionSnapshot(view)')
      && pendingRebindCapture.includes('this.pendingCollabRebindSelectionSnapshot = snapshot;'),
    'Expected collab document reset to capture the local cursor before clearing/rebinding the editor',
  );
  assert(
    source.includes('this.capturePendingCollabRebindSelection(view);')
      && source.includes('this.restorePendingCollabRebindSelection(ctx.get(editorViewCtx));'),
    'Expected collab reset/hydration to capture and restore the local cursor around rebinds',
  );
  assert(
    pendingRebindRestore.includes("setMeta('proof-local-selection-restore', true)")
      && pendingRebindRestore.includes('this.restoreScrollAfterRemoteYjsTransaction(snapshot.scrollY)'),
    'Expected collab rebind restoration to restore cursor and scroll without changing document history',
  );
  assert(
    stabilizer.includes('this.isYjsChangeOriginTransaction(sourceTransaction)'),
    'Expected cursor stabilizer to only handle remote Yjs-origin transactions',
  );
  assert(
    systemTransactionDetector.includes("transaction.getMeta?.('document-load') !== undefined")
      && systemTransactionDetector.includes('transaction.getMeta?.(marksPluginKey) !== undefined'),
    'Expected document-load and remote mark hydration transactions to be treated as cursor-displacing system updates',
  );
  assert(
    systemTransactionDetector.includes("transaction.getMeta?.('proof-local-pointer-selection') === true")
      && systemTransactionDetector.includes('this.isYjsChangeOriginTransaction(transaction)'),
    'Expected system cursor repair to preserve intentional local pointer selections and leave Yjs transactions to the Yjs guard',
  );
  assert(
    systemTransactionStabilizer.includes('if (!localSelectionOwnedBeforeDispatch) return;')
      && systemTransactionStabilizer.includes('this.resolveStableLocalSelection(view, sourceTransaction, selectionSnapshot)')
      && systemTransactionStabilizer.includes("setMeta('proof-local-selection-restore', true)"),
    'Expected system document updates on older repaired docs to restore the locally owned cursor',
  );
  assert(
    unexpectedSnapStabilizer.includes('sourceTransaction.getMeta?.(\'addToHistory\') === false')
      && unexpectedSnapStabilizer.includes('currentSelection.from <= 3'),
    'Expected a last-line guard against non-user transactions snapping focused humans to the document start',
  );
  // The far-jump branch must REQUIRE landing at the top of the doc; otherwise a
  // legitimate large remote paste (>1000 chars inserted before the caret) gets
  // flagged as an anomaly and we re-introduce the original stale-snapshot bug
  // (caret jumps backward into the freshly-inserted remote content).
  assert(
    unexpectedSnapStabilizer.includes('jumpedFarAwayAndSnappedToStart')
      && unexpectedSnapStabilizer.includes('Math.abs(currentSelection.from - beforeSelection.from) > 1000')
      && unexpectedSnapStabilizer.includes('currentSelection.from <= 3'),
    'Expected the far-jump branch to require currentSelection.from <= 3 so legitimate large remote inserts do not re-trigger stale-snapshot restoration',
  );
  assert(
    unexpectedSnapStabilizer.includes("sourceTransaction.getMeta?.('proof-local-pointer-selection') === true")
      && unexpectedSnapStabilizer.includes('if (!sourceTransaction?.docChanged) return;'),
    'Expected the last-line cursor guard not to undo intentional local clicks or selection-only navigation',
  );
  assert(
    !stabilizer.includes('if (sourceTransaction?.selectionSet === true) return;'),
    'Expected cursor stabilizer not to blindly trust y-prosemirror when it moves the local caret to the document start',
  );
  assert(
    selectionCapture.includes('absolutePositionToRelativePosition(selection.anchor'),
    'Expected local cursor snapshots to store the anchor as a Yjs relative position before remote edits apply',
  );
  assert(
    selectionCapture.includes('absolutePositionToRelativePosition(selection.head'),
    'Expected local cursor snapshots to store the head as a Yjs relative position before remote edits apply',
  );
  assert(
    source.includes('relativePositionToAbsolutePosition('),
    'Expected cursor restoration to resolve Yjs relative positions after remote edits apply',
  );
  assert(
    stableSelectionResolver.includes('resolveRelativeSelectionSnapshot'),
    'Expected cursor restoration to prefer CRDT-relative cursor positions',
  );
  assert(
    stableSelectionResolver.includes('resolveBookmarkSelectionSnapshot'),
    'Expected cursor restoration to retain the ProseMirror bookmark fallback',
  );
  assert(
    stableSelectionResolver.includes('resolveAbsoluteSelectionSnapshot'),
    'Expected cursor restoration to fall back to the last absolute local caret when all relative mapping snaps to the document start',
  );
  assert(
    source.includes('selectionAppearsAtDocumentStart'),
    'Expected cursor restoration to detect false document-start remaps',
  );
  assert(
    remoteSelectionRestore.includes('stabilizedSelection.eq(currentSelection)'),
    'Expected remote cursor repair to short-circuit when the resolved selection already matches',
  );
  // The stabilizer must NOT fire for ordinary remote inserts/deletes — y-prosemirror's own
  // restoreRelativeSelection (running with the post-tx mapping) already keeps the caret coherent.
  // By the time our dispatch override runs, the binding mapping has been rebuilt, so a snapshot
  // taken with the old absolute positions no longer round-trips through relative-position resolution.
  // Re-asserting that snapshot drags the caret backward by every remote insertion that landed
  // before it. The Yjs stabilizer is therefore restricted to the actual "snapped to top" failure
  // mode it was designed to catch.
  assert(
    stabilizer.includes('currentSelection.from > 3'),
    'Expected the Yjs stabilizer to bail out unless the caret has actually snapped to the document top',
  );
  assert(
    stabilizer.includes('beforeSelection.from <= 3'),
    'Expected the Yjs stabilizer to bail out when the local caret was already at the top before dispatch',
  );
  assert(
    stabilizer.includes('this.pendingCollabRebindSelectionSnapshot')
      && stabilizer.includes('this.pendingCollabRebindSelectionSnapshot = null;'),
    'Expected the Yjs stabilizer to consume pending pre-rebind cursor snapshots for older document reconnects',
  );
  assert(
    stabilizer.includes("setMeta('proof-local-selection-restore', true)"),
    'Expected restored selection transactions to be marked explicitly',
  );
  assert(
    stabilizer.includes('this.restoreScrollAfterRemoteYjsTransaction(beforeSelection.scrollY)'),
    'Expected remote cursor repair to restore the focused user scroll position after remote edits',
  );
  assert(
    !stabilizer.includes('lastLocalTypingAt') && !stabilizer.includes('remoteCursorStabilityWindowMs'),
    'Expected focused cursor preservation not to expire while another human is typing',
  );
  assert(
    !stabilizer.includes('TextSelection.near'),
    'Expected cursor stabilizer not to snap to a nearby random text position',
  );

  assert(
    source.includes('dispatchWithRevision(tr);\n            this.stabilizeCursorAfterRemoteYjsTransaction('),
    'Expected suggestion-mode Yjs transactions to restore the local cursor before returning',
  );
  assert(
    source.includes('this.stabilizeCursorAfterSystemTransaction('),
    'Expected document-load and mark-hydration transactions to share the local cursor stabilization path',
  );
  assert(
    source.includes('this.stabilizeCursorAfterUnexpectedSelectionSnap('),
    'Expected the dispatch wrapper to run the last-line cursor snap guard after remote/system updates',
  );
  assert(
    source.includes('isLiveCollabDocumentUpdatedEvent(event)'),
    'Expected live-collab history events not to force collab refresh/reconnect',
  );

  const collabClientPath = path.resolve(process.cwd(), 'src', 'bridge', 'collab-client.ts');
  const collabClientSource = readFileSync(collabClientPath, 'utf8');
  assert(
    collabClientSource.includes("source === 'live-collab' || source === 'live-collab-backfill'"),
    'Expected stateless live-collab document.updated messages not to force resync',
  );

  console.log('✓ focused local cursor is preserved across remote collab edits');
}

run();
