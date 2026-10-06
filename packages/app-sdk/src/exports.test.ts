/**
 * The public runtime surface of each entry point, as an explicit budget: any
 * addition or removal is an API decision and must update this list (and the
 * package README). Types are reviewed with the declarations.
 */
import { expect, it } from 'vitest';

it.each([
  [
    '@sempods/app-sdk',
    () => import('./index.js'),
    [
      'RuntimeError',
      'bindResourceEditor',
      'createAppController',
      'createBrowserRuntime',
      'createFormatters',
      'createLocale',
      'createViewLoader',
      'describeFailure',
      'englishMessages',
      'germanMessages',
      'resolveLocale',
    ],
  ],
  [
    '@sempods/app-sdk/react',
    () => import('./react/index.js'),
    [
      'AccessNotice',
      'AppAccess',
      'AppShell',
      'CallbackNotice',
      'ConnectionControls',
      'ResourceEditor',
      'SdkLocaleProvider',
      'SempodsProvider',
      'TargetScreen',
      'UpdateNotice',
      'useApp',
      'useAppState',
      'useConnections',
      'useCreation',
      'useDraftGuard',
      'useFieldUpdate',
      'useList',
      'useLoad',
      'usePodLoad',
      'useResourceEditor',
      'useSdkLocale',
      'useSelection',
      'useView',
      'useWorkflowAccess',
    ],
  ],
] as const)('%s exports exactly its budget', async (_entry, load, names) => {
  expect(Object.keys(await load()).sort()).toEqual([...names]);
});
