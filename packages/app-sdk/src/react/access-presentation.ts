import type { AppSnapshot } from '../authoring/app.js';
import type { Connection } from '../runtime/types.js';

/** Private rendering inputs; history stays with AppAccess, authority with the runtime. */
export interface AccessFacts {
  readonly state: Pick<
    AppSnapshot,
    | 'startup'
    | 'startupError'
    | 'callbackNotice'
    | 'contextSelection'
    | 'preset'
  >;
  readonly connection: Connection | undefined;
  readonly podReadable: boolean;
  readonly viewReadable: boolean;
  readonly hasView: boolean;
  readonly demand: 'none' | 'discovery' | 'selection';
  readonly manage: boolean;
  readonly catalogueSettled: boolean;
  readonly retry: boolean;
  readonly headingLevel?: 1 | 2;
}

export type ConnectionBody = 'leaving' | 'loading' | 'connections';
type AccessBody =
  | 'startup-error'
  | 'starting'
  | 'busy'
  | 'unavailable'
  | 'none'
  | 'retry'
  | ConnectionBody;

/**
 * One render decision, without effects or retained state. Startup overrides the
 * body; otherwise attention/management shows leaving, initial loading or the
 * connection controls. Usable access shows only a retained retry/notice or hides.
 */
export function presentAccess(f: AccessFacts) {
  const { state, connection: c } = f;
  const selection = f.demand === 'selection';
  const discovery = f.demand !== 'none';
  const readable =
    state.contextSelection === 'on-demand' ? f.podReadable : f.viewReadable;
  const active = c?.session.kind === 'active' || c?.session.kind === 'renewing';
  const missingScopes = Boolean(c?.missingRequiredScopes.length);
  const catalogueFailed = c?.catalogue.kind === 'failed';
  // Re-authorization keeps its subject for display. Only missing scopes keeps
  // attention while leaving; a catalogue recovery view hides at that point.
  const attention =
    c?.session.kind === 'leaving'
      ? !c.session.subject || missingScopes
      : !readable ||
        (selection && !f.viewReadable) ||
        (discovery && catalogueFailed);
  const visible = attention || f.manage || state.callbackNotice || f.retry;
  // A settled catalogue reload retains the connection controls and their focus.
  const validating =
    !f.manage &&
    !state.callbackNotice &&
    Boolean(c) &&
    !catalogueFailed &&
    !(selection && c?.catalogue.kind === 'ready') &&
    (c?.session.kind === 'restoring' ||
      (active &&
        !missingScopes &&
        ((selection && !f.catalogueSettled) || !f.podReadable)));

  let body: AccessBody;
  if (state.startupError) body = 'startup-error';
  else if (!state.startup) body = 'starting';
  else if (state.startup.storage === 'busy') body = 'busy';
  else if (state.startup.storage === 'unavailable') body = 'unavailable';
  else if (attention || f.manage)
    body =
      c?.session.kind === 'leaving'
        ? 'leaving'
        : validating
          ? 'loading'
          : 'connections';
  else body = f.retry ? 'retry' : 'none';

  const notice =
    body === 'connections' &&
    active &&
    (missingScopes ||
      (discovery && catalogueFailed) ||
      (selection &&
        Boolean(
          c?.selectedContext ||
          c?.catalogue.kind !== 'ready' ||
          state.preset?.contextIri,
        )));
  return {
    attention,
    visible,
    body,
    notice,
    heading:
      (f.headingLevel ?? (f.manage || f.hasView ? 2 : 1)) === 2
        ? ('h2' as const)
        : ('h1' as const),
    namesApp: !(f.manage || f.hasView || f.headingLevel === 2),
    initial: !f.hasView && !f.manage,
  };
}
