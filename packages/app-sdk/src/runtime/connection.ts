import { RuntimeError } from './errors.js';
import type { AuthCredential, CatalogueResult, Pod } from '@sempods/client-sdk';
import type {
  PodDiscovery,
  OAuthClient,
  ExchangeResult,
} from '@sempods/client-sdk/oauth';
import type { Connection } from './types.js';
import type { BoundView } from './view.js';

export interface Entry {
  pod: PodDiscovery;
  client: OAuthClient;
  view: Connection;
  generation: string;
  lifetime: AbortController;
  reads: AbortController;
  credentials?: ExchangeResult;
  credential?: AuthCredential;
  revision: string | null;
  persistence: Promise<void>;
  epoch: number;
  selectedVersion: number;
  bound?: BoundView;
  catalogue?: Promise<CatalogueResult>;
  revalidation?: Promise<void>;
  refresh?: Promise<boolean>;
  clientPod: Pod;
}

/** Credentials never follow a subject IRI or another pod's route. */
export function assertCredentialRecipient(
  podUrl: string,
  recipient: string,
): void {
  let pod: URL;
  let url: URL;
  try {
    pod = new URL(podUrl);
    url = new URL(recipient);
  } catch {
    throw new RuntimeError('configuration');
  }
  if (
    url.href !== recipient ||
    url.origin !== pod.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith(pod.pathname.replace(/\/$/, '') + '/_system/')
  )
    throw new RuntimeError('configuration');
}
