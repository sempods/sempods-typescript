import type { AppSnapshot } from '../authoring/app.js';
import type { CatalogueFact, Connection } from '../runtime/types.js';

/**
 * The Contexts to show: a ready catalogue's, or the earlier ones a reload keeps
 * until it settles; none before the first catalogue or after a failure.
 */
export function knownContexts(catalogue: CatalogueFact | undefined) {
  return catalogue?.kind === 'ready' || catalogue?.kind === 'loading'
    ? catalogue.contexts
    : undefined;
}

/** Private rendering inputs; authority stays with the runtime. */
export interface AccessFacts {
  readonly state: Pick<AppSnapshot, 'contextSelection' | 'preset'>;
  readonly connection: Connection | undefined;
  readonly podReadable: boolean;
  readonly viewReadable: boolean;
  readonly hasView: boolean;
  readonly demand: 'none' | 'discovery' | 'selection';
  readonly manage: boolean;
  readonly catalogueSettled: boolean;
  readonly headingLevel?: 1 | 2;
}

export type ConnectionBody = 'leaving' | 'loading' | 'connections';

/**
 * One render decision, without effects or retained state. Session and startup
 * problems belong to the gate and the prompts: inline, this shows only Context
 * attention of a usable connection (a selection it needs, a failed demanded
 * catalogue, the first catalogue load). Management always shows.
 */
export function presentAccess(f: AccessFacts) {
  const { state, connection: c } = f;
  const selection = f.demand === 'selection';
  const discovery = f.demand !== 'none';
  const readable =
    state.contextSelection === 'on-demand' ? f.podReadable : f.viewReadable;
  // Signed in, or reading without a token: Context attention applies.
  const active = c !== undefined && c.reading !== null;
  const missingScopes = Boolean(c?.missingRequiredScopes.length);
  const usable = active && !missingScopes;
  const catalogueFailed = c?.catalogue.kind === 'failed';
  const attention =
    usable &&
    (!readable ||
      (selection && !f.viewReadable) ||
      (discovery && catalogueFailed));
  const visible = attention || f.manage;
  // A settled catalogue reload retains the connection controls and their focus.
  const validating =
    !f.manage &&
    usable &&
    !catalogueFailed &&
    !(selection && c?.catalogue.kind === 'ready') &&
    ((selection && !f.catalogueSettled) || !f.podReadable);
  const body: ConnectionBody =
    c?.session.kind === 'leaving'
      ? 'leaving'
      : validating
        ? 'loading'
        : 'connections';
  const notice =
    visible &&
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
  };
}
