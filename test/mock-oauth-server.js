// Hmelj — a stand-in OAuth2 provider, so the sign-in flow can be tested
// without a real Microsoft account (and without a browser).
//
// It implements just enough of the authorization-code + PKCE dance to exercise
// server/oauth.js honestly:
//   - /authorize verifies the request shape and redirects straight back with a
//     code, no user interaction
//   - /token verifies the PKCE verifier against the challenge and issues an
//     access token, an id_token, and a ROTATING refresh token — rotation is
//     the behaviour that actually matters here, because Microsoft does it on
//     every refresh and silently dropping the new one kills the account about
//     an hour after setup
//
// Knobs for the failure paths (set on the server object after start()):
//   signInAs      — pretend a different address signed in than was asked for
//   rejectRefresh — answer invalid_grant, i.e. consent revoked / token aged out
//   tokenError    — fail /token with a chosen provider error (AADSTS…)
//   grantScope    — grant narrower scopes than requested, as an app registration
//                   missing the Graph permissions does
//   secretsSeen   — counter: how many token requests carried a client_secret.
//                   For a Microsoft-style flow this must stay 0. Hmelj registers
//                   as a PUBLIC client there, and sending a secret to a
//                   public-client registration is an error, not a harmless extra
//                   — so the mock rejects it outright below rather than quietly
//                   accepting it the way a lenient stub would.
//   requireSecret — flips that around, to model a CONFIDENTIAL client (Google's
//                   "Web application", the only kind whose redirect can be a
//                   server-side URL): set it to the expected secret and /token
//                   then REJECTS any request that omits or mistypes it.
//   fixedAccessToken — issue this exact access token instead of a random one, so
//                   a mock IMAP/SMTP server can be configured to accept it and
//                   the XOAUTH2 leg gets exercised for real.
//   rotateRefresh — false makes /token answer a refresh WITHOUT a new refresh
//                   token and keep the old one valid, which is Google's
//                   behaviour (Microsoft's rotation is the default here).
//   tokenRequests — counter, for asserting the access-token cache actually caches
import http from 'http';
import crypto from 'crypto';
import { URL } from 'url';

const b64url = (b) => Buffer.from(b).toString('base64url');

export function startMockOAuth(port = 3066) {
  const codes = new Map();       // code -> { challenge, redirectUri, email }
  const refreshTokens = new Set();
  const state = {
    signInAs: null,
    rejectRefresh: false,
    tokenRequests: 0,
    issuedRefreshTokens: [],
    // Set to {error, error_description} to make /token fail with a specific
    // provider error — used to check that Microsoft's AADSTS codes get
    // translated into something a self-hoster can act on.
    tokenError: null,
    // Grant NARROWER scopes than were requested, which is what an app
    // registration missing the Graph permissions really does: the sign-in
    // succeeds and the token simply isn't allowed to read the mailbox.
    grantScope: null,
    secretsSeen: 0,
    // Confidential-client mode (Google). See the header notes.
    requireSecret: null,
    fixedAccessToken: null,
    rotateRefresh: true,
  };

  const issueAccess = () => state.fixedAccessToken || ('at_' + crypto.randomBytes(8).toString('hex'));

  const idTokenFor = (email) =>
    [b64url('{"alg":"none"}'), b64url(JSON.stringify({ email, preferred_username: email })), ''].join('.');

  const issueRefresh = () => {
    const t = 'rt_' + crypto.randomBytes(8).toString('hex');
    refreshTokens.add(t);
    state.issuedRefreshTokens.push(t);
    return t;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (url.pathname === '/authorize') {
      const q = url.searchParams;
      // Assert the request shape here rather than in the test, so ANY test
      // that completes a sign-in also proves the auth URL was well-formed.
      for (const required of ['client_id', 'response_type', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method']) {
        if (!q.get(required)) return json(400, { error: 'invalid_request', error_description: `missing ${required}` });
      }
      if (q.get('code_challenge_method') !== 'S256') return json(400, { error: 'invalid_request', error_description: 'PKCE must be S256' });
      const code = 'code_' + crypto.randomBytes(8).toString('hex');
      codes.set(code, {
        challenge: q.get('code_challenge'),
        redirectUri: q.get('redirect_uri'),
        email: state.signInAs || q.get('login_hint') || 'nobody@example.com',
      });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state'));
      res.writeHead(302, { Location: back.toString() });
      return res.end();
    }

    if (url.pathname === '/token' && req.method === 'POST') {
      state.tokenRequests++;
      const body = await new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => resolve(new URLSearchParams(b)));
      });
      if (state.tokenError) return json(401, state.tokenError);
      if (!body.get('client_id')) {
        return json(401, { error: 'invalid_client', error_description: 'client_id missing' });
      }
      // Confidential client: the secret is mandatory and checked. Google
      // answers a missing/wrong one with invalid_client, which is what
      // server/oauth.js's explainProviderError turns into "paste the client
      // secret" rather than a bare provider error.
      if (state.requireSecret) {
        const seen = body.get('client_secret');
        if (seen) state.secretsSeen++;
        if (seen !== state.requireSecret) {
          return json(401, { error: 'invalid_client', error_description: 'The OAuth client was not found, or client_secret is missing.' });
        }
      } else if (body.get('client_secret')) {
      // A public-client registration rejects a secret rather than ignoring it.
      // Asserting that here means any test which completes a sign-in also
      // proves Hmelj never sends one.
        state.secretsSeen++;
        return json(401, {
          error: 'invalid_request',
          error_description: 'AADSTS700025: Client is public so neither client_assertion nor client_secret should be presented.',
        });
      }
      // PKCE is the only thing binding this exchange to the flow that started
      // it, so a code exchange with no verifier must fail.
      if (body.get('grant_type') === 'authorization_code' && !body.get('code_verifier')) {
        return json(400, { error: 'invalid_grant', error_description: 'code_verifier required for a public client' });
      }

      if (body.get('grant_type') === 'authorization_code') {
        const entry = codes.get(body.get('code'));
        if (!entry) return json(400, { error: 'invalid_grant', error_description: 'unknown code' });
        codes.delete(body.get('code')); // codes are single-use, like the real thing
        const verifier = body.get('code_verifier') || '';
        const expect = b64url(crypto.createHash('sha256').update(verifier).digest());
        if (expect !== entry.challenge) return json(400, { error: 'invalid_grant', error_description: 'PKCE verifier mismatch' });
        if (body.get('redirect_uri') !== entry.redirectUri) return json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return json(200, {
          access_token: issueAccess(),
          refresh_token: issueRefresh(),
          id_token: idTokenFor(entry.email),
          expires_in: 3600,
          scope: state.grantScope ?? (body.get('scope') || ''),
          token_type: 'Bearer',
        });
      }

      if (body.get('grant_type') === 'refresh_token') {
        if (state.rejectRefresh) return json(400, { error: 'invalid_grant', error_description: 'consent was revoked' });
        if (!refreshTokens.has(body.get('refresh_token'))) {
          return json(400, { error: 'invalid_grant', error_description: 'unknown refresh token' });
        }
        // Rotation: the old one dies the moment a new one is issued, exactly
        // as Microsoft behaves. A client that fails to store the new token
        // gets invalid_grant on its NEXT refresh, not this one — which is
        // what makes the bug so easy to miss.
        //
        // rotateRefresh:false is Google instead — no new refresh token in the
        // response at all, and the original stays valid indefinitely. A client
        // that "helpfully" replaces the stored token with undefined breaks on
        // its next refresh, so this is the mirror-image trap.
        if (state.rotateRefresh) refreshTokens.delete(body.get('refresh_token'));
        return json(200, {
          access_token: issueAccess(),
          ...(state.rotateRefresh ? { refresh_token: issueRefresh() } : {}),
          expires_in: 3600,
          scope: state.grantScope ?? (body.get('scope') || ''),
          token_type: 'Bearer',
        });
      }

      return json(400, { error: 'unsupported_grant_type' });
    }

    json(404, { error: 'not_found' });
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        server,
        state,
        authorizeUrl: `http://127.0.0.1:${port}/authorize`,
        tokenUrl: `http://127.0.0.1:${port}/token`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Runnable on its own for manual poking: node test/mock-oauth-server.js
if (import.meta.url === `file://${process.argv[1]}`) {
  const m = await startMockOAuth(Number(process.env.PORT) || 3066);
  console.log('mock OAuth provider on', m.authorizeUrl);
}
