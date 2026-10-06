/**
 * The public runtime surface of each entry point, as an explicit budget: any
 * addition or removal is an API decision and must update this list (and the
 * package README). Types are reviewed with the declarations.
 */
import { expect, it } from 'vitest';

it.each([
  [
    '@sempods/client-sdk',
    () => import('./index.js'),
    [
      'CatalogueError',
      'SdkError',
      'anonymous',
      'bearer',
      'createPod',
      'decodeCatalogue',
      'isContextIri',
      'sdkFailure',
    ],
  ],
  [
    '@sempods/client-sdk/oauth',
    () => import('./oauth/index.js'),
    [
      'OAuthError',
      'createClientRegistry',
      'discoverPod',
      'exchangeAuthorization',
      'prepareAuthorization',
      'refreshAuthorization',
    ],
  ],
  [
    '@sempods/client-sdk/oauth/host',
    () => import('./oauth/host.js'),
    [
      'assertRefreshContinuity',
      'callbackUrl',
      'checkDidWeb',
      'parseStoredCredentials',
      'scopeList',
      'validateAuthorizationCallback',
      'validateOAuthBinding',
    ],
  ],
  [
    '@sempods/client-sdk/edit',
    () => import('./edit/index.js'),
    [
      'MappingError',
      'createResourceEditor',
      'dateTime',
      'fields',
      'flag',
      'iri',
      'isFieldDefinition',
      'listSubjects',
      'newSubjectIri',
      'prepareCreation',
      'removeSnapshot',
      'snapshots',
      'text',
      'updateFields',
    ],
  ],
] as const)('%s exports exactly its budget', async (_entry, load, names) => {
  expect(Object.keys(await load()).sort()).toEqual([...names]);
});
