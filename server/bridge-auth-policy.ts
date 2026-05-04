export type BridgeAuthMode = 'none' | 'bridge-token';
export type BridgeMethod = 'GET' | 'POST';

export interface BridgeRoutePolicy {
  method: BridgeMethod;
  path: string;
  auth: BridgeAuthMode;
  required?: string[];
}

// All bridge MUTATION routes now require a bridge token. The previous policy
// marked many of them `auth: 'none'`, which let any LAN caller who knew a slug
// post arbitrary comments, suggestions, AND a full-document /rewrite without
// any credential. GET /state and GET /marks remain `auth: 'none'` because the
// document is the slug-as-secret model on tokenless reads — and the slug also
// gates discovery — but that lenient policy must not extend to write paths.
const BRIDGE_ROUTE_POLICIES: BridgeRoutePolicy[] = [
  { method: 'GET', path: '/state', auth: 'none' },
  { method: 'GET', path: '/marks', auth: 'none' },
  // Native bridge allows selector-based comments without quote.
  { method: 'POST', path: '/marks/comment', auth: 'bridge-token', required: ['by', 'text'] },
  { method: 'POST', path: '/comments', auth: 'bridge-token', required: ['by', 'text'] },
  { method: 'POST', path: '/marks/suggest-replace', auth: 'bridge-token', required: ['quote', 'by', 'content'] },
  { method: 'POST', path: '/marks/suggest-insert', auth: 'bridge-token', required: ['quote', 'by', 'content'] },
  { method: 'POST', path: '/marks/suggest-delete', auth: 'bridge-token', required: ['quote', 'by'] },
  { method: 'POST', path: '/suggestions', auth: 'bridge-token', required: ['kind', 'quote', 'by'] },
  { method: 'POST', path: '/marks/accept', auth: 'bridge-token', required: ['markId'] },
  { method: 'POST', path: '/marks/reject', auth: 'bridge-token', required: ['markId'] },
  { method: 'POST', path: '/marks/reply', auth: 'bridge-token', required: ['markId', 'by', 'text'] },
  { method: 'POST', path: '/marks/resolve', auth: 'bridge-token', required: ['markId'] },
  { method: 'POST', path: '/comments/reply', auth: 'bridge-token', required: ['markId', 'by', 'text'] },
  { method: 'POST', path: '/comments/resolve', auth: 'bridge-token', required: ['markId'] },
  // Native bridge accepts content OR changes and defaults by to ai:unknown.
  { method: 'POST', path: '/rewrite', auth: 'bridge-token' },
  { method: 'POST', path: '/presence', auth: 'bridge-token', required: ['status'] },
];

export function findBridgeRoutePolicy(method: string, path: string): BridgeRoutePolicy | undefined {
  const normalizedMethod = method.toUpperCase() as BridgeMethod;
  return BRIDGE_ROUTE_POLICIES.find((policy) => policy.method === normalizedMethod && policy.path === path);
}

export function getBridgeRoutePolicies(): BridgeRoutePolicy[] {
  return BRIDGE_ROUTE_POLICIES;
}
