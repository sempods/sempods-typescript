/** Loopback wire fixture only: not evidence from a deployed Kotlin pod. */
export function discoveryDocument(origin, path) {
  const pod = `${origin}/alice`;
  if (path === '/alice/.well-known/oauth-protected-resource') {
    return {
      resource: pod,
      authorization_servers: [pod],
      bearer_methods_supported: ['header'],
    };
  }
  if (path === '/alice/.well-known/oauth-authorization-server') {
    return {
      issuer: pod,
      authorization_endpoint: `${pod}/authorize`,
      token_endpoint: `${pod}/token`,
      registration_endpoint: `${pod}/register`,
      jwks_uri: `${pod}/jwks`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: ['none'],
      code_challenge_methods_supported: ['S256'],
    };
  }
  return null;
}

/** Loopback resource fixture for the packed client: one task with a strong ETag. */
export function resourceAnswer(origin, method, path, headers) {
  const pod = `${origin}/alice`;
  const route = `/alice/_system/resources/${Buffer.from(`${pod}/tasks/1`, 'utf8').toString('base64url')}`;
  const url = new URL(path, origin);
  if (url.pathname !== route) return null;
  if (
    url.searchParams.getAll('context').join() !==
    `${pod}/_system/contexts/tasks`
  )
    return { status: 400 };
  if (headers.authorization !== 'Bearer consumer-token') return { status: 401 };
  if (method === 'GET')
    return {
      status: 200,
      headers: { 'content-type': 'application/ld+json', etag: '"v1"' },
      body: JSON.stringify({ '@id': `${pod}/tasks/1` }),
    };
  if (method === 'PATCH')
    return { status: headers['if-match'] === '"v1"' ? 204 : 412 };
  return { status: 405 };
}
