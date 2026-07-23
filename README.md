# ssooidc

A Blueprint extension for [Pterodactyl](https://pterodactyl.io) that adds
**OpenID Connect (OIDC) single sign-on login**, as an addition to the built-in
username/password login. Accounts are created just-in-time on first login and
matched to existing accounts by email on every single login — nothing about
that match is persisted, so it's re-decided fresh every time. 2FA is skipped
for SSO logins, since the second factor is the IdP's responsibility once
federated. An admin panel toggle can hide the native username/password form
entirely and redirect straight to the configured IdP.

## Features

- **OIDC Authorization Code Flow with PKCE** (S256) against any standard
  OIDC provider (tested against [authentik](https://goauthentik.io)).
- **Just-in-time account provisioning**: a new Pterodactyl account is
  created automatically on first SSO login, no admin action needed.
- **Just-in-time account updates**: email, username, first/last name and
  admin status are refreshed from the IdP's claims on **every** SSO login,
  for both new and pre-existing accounts.
- **Email-based account linking, decided fresh every login** — nothing is
  persisted as a "link"; if the email changes at the IdP, the next login
  simply resolves to a different (or new) account.
- **Admin status fully controlled by the IdP** via a configurable claim
  name/value (e.g. group membership) — see "Why `root_admin` is fully
  IdP-controlled" below.
- **2FA (TOTP) is skipped for SSO logins** — the second factor becomes the
  IdP's responsibility once authentication is federated.
- **Optional "hide password login"** toggle: redirect straight to the IdP
  instead of showing the native login form, with a `?auto_sso=0` escape
  hatch to always be able to reach the classic form in an emergency.
- **RP-Initiated Logout**: logging out of Pterodactyl also ends the session
  at the IdP (both the client dashboard and admin panel logout buttons).
- **Back-Channel Logout** and **Front-Channel Logout**: logging out (or a
  session ending) *at the IdP* also ends the matching Pterodactyl session,
  even without the browser being involved.
- **ACR (requested) / AMR (enforced)** authentication-strength controls —
  optionally reject SSO logins that didn't use an expected authentication
  method (e.g. require MFA).
- **`access_token` revocation** and a **`userinfo_endpoint` fallback** for
  claims missing from the ID token, both automatic and transparent.
- **Client secret encrypted at rest** (Laravel's `Crypt`/`APP_KEY`), never
  echoed back into the admin form.
- **HTTPS enforced** for the whole SSO flow (localhost exempted for local
  development).
- **Clean install/update/remove**: reinstalling or removing the extension
  fully cleans up its database rows and tables — see "Why `remove.sh`
  cleans up the database itself" below.

## How it works

The OIDC authorization-code flow itself (`/redirect`, `/callback`) and a
public settings endpoint (`/config`) are implemented as plain Laravel
controllers/services under `app/`, bound via `requests.app` +
`requests.routers.web` in `conf.yml`. Account provisioning talks to
Pterodactyl's own `User` model and `Auth` facade directly — Blueprint's
`BlueprintExtensionLibrary` only offers generic key-value storage
(`dbGet`/`dbSet`), no user/auth helpers.

### Why `requests.routers.web` for `/redirect` and `/callback`

OAuth/OIDC redirects can't sit behind a session-authenticated route — the
browser has no panel session yet when the IdP redirects back with the
authorization code. `requests.routers.web` is Blueprint's only unauthenticated
router type, prefixed `/extensions/ssooidc/...`.

### Why PKCE, even with a confidential client

[`OidcRedirectController`](app/Http/OidcRedirectController.php) generates a
`code_verifier` alongside `state`/`nonce` (same hex-random generation style -
a hex string is a valid, if unusual, PKCE `code_verifier` charset per RFC
7636) and sends its S256 `code_challenge` in the authorization request;
[`OidcCallbackController`](app/Http/OidcCallbackController.php) sends the
original verifier back when exchanging the code. Strictly speaking this
extension doesn't need it - it's a confidential client (holds a
`client_secret`), and PKCE exists primarily to protect public clients that
can't keep a secret. It's included anyway as a cheap extra layer against
authorization-code interception/injection, and every provider that matters
(authentik, Keycloak, Azure AD, Google, ...) supports `S256`.

### Why AMR is enforced, but ACR is only requested

2FA is skipped for SSO logins on the assumption that the IdP already
enforced it - but nothing actually checked that assumption. "Requested ACR
values" sends `acr_values` in the authorization request, a best-effort hint
providers are free to ignore (ACR is a free-form, provider-specific string,
with no reliable way to assert "MFA happened" from the value alone).
"Required AMR values" is the real enforcement: after verifying the
id_token, [`OidcCallbackController::assertAmrSatisfied()`](app/Http/OidcCallbackController.php)
checks its `amr` claim (Authentication Methods References, RFC 8176 -
semi-standardized values like `mfa`, `otp`, `pwd`) against an admin-configured
list and rejects the login if none match. If the provider doesn't send
`amr` at all, that's treated as *not satisfied* (fails closed) rather than
skipped. Left empty (the default), nothing is checked, matching the
original behavior.

### Why the access_token is revoked right after login

This extension only ever needs the `id_token`'s claims - `exchangeCode()`
still gets back an `access_token` (every OAuth2 token response includes
one), which is otherwise simply unused and left valid at the provider for
its full lifetime for no reason. [`OidcClientService::revokeToken()`](app/Services/OidcClientService.php)
POSTs it to the provider's `revocation_endpoint` (RFC 7009) after a
successful login - deferred via `dispatch(...)->afterResponse()` so it runs
*after* the redirect has already been sent to the browser, not before. It
used to run inline, blocking the response on it: a slow revocation_endpoint
added enough latency to occasionally push the whole callback request past a
reverse proxy's timeout, which then returned `503` to the browser even
though the login had already fully succeeded server-side - and a reload
after that `503` replays the (already-consumed) authorization code,
failing with a confusing `invalid_grant` (confirmed against a live deploy
behind a reverse proxy). Revocation is cleanup, never something the user
should have to wait on - best-effort and silent on failure either way, a
provider without a revocation endpoint (or a revoke call that fails) must
never block or break the login itself.

### Why there's a userinfo_endpoint fallback

Claims are read from the `id_token` by default. Some providers/configurations
don't put every claim there (only what's requested via scopes ends up in the
id_token in some setups, while others also require a `userinfo_endpoint`
call for the same data). If any of the configured claim names are missing
from the id_token, [`OidcCallbackController::fillMissingClaimsFromUserInfo()`](app/Http/OidcCallbackController.php)
fetches `userinfo_endpoint` (Bearer-authenticated with the access_token,
right before it gets revoked) and fills in the gaps - id_token claims always
win on conflict, since they're signed and the userinfo response merely
rides on TLS + bearer auth.

### Why `login_hint` is wired up but unused by the UI

[`OidcRedirectController`](app/Http/OidcRedirectController.php) forwards an
optional `?login_hint=` query parameter to the authorization request
(pre-fills the provider's login form) - purely plumbing for callers that
already know a likely email (e.g. a future "switch account" link, or an
external integration linking straight to `/extensions/ssooidc/redirect`).
Nothing in the current login page passes one - before the user
authenticates, this extension doesn't know who they are - so this is a
no-op today unless something explicitly builds that query string.

### Why `lcobucci/jwt` instead of a new composer dependency

Extensions can't add composer dependencies — there's no build step for that.
Pterodactyl's own `composer.json` already requires `lcobucci/jwt` (used
internally for the panel's own signed URLs) and `guzzlehttp/guzzle`, which is
enough to do proper OIDC discovery, JWKS retrieval and ID-token signature
verification without pulling in anything extra. `lcobucci/jwt` has no built-in
JWK parser, so [`app/Services/JwkToPem.php`](app/Services/JwkToPem.php) hand-encodes an RSA JWK
(`n`, `e`) into a DER/PEM public key via plain ASN.1 encoding.

### Why `client_secret` is encrypted, and never echoed back into the form

`BlueprintExtensionLibrary`'s `dbSet()`/`dbGet()` only *serialize* values
(plain PHP `serialize()`), they don't encrypt anything - confirmed by
reading a `client_secret` back in plain text via `php artisan tinker`
against a live install. Anyone with DB or backup read access would see it.
[`OidcSettingsProvider`](app/Http/OidcSettingsProvider.php) now encrypts it
with Laravel's `Crypt` facade (AES via `APP_KEY`, already available - no
new dependency) before it's stored, and decrypts it on read (falling back
to treating the value as plaintext if decryption fails, so an
already-plaintext value from before this change keeps working immediately
rather than breaking login). Migration `2026_07_23_000004_encrypt_client_secret.php`
one-time-encrypts whatever's already stored on upgrade.

Since the value is encrypted, the admin form also stops echoing the actual
secret back into the input (there'd be nothing meaningful to show anyway -
you can't decrypt it usefully into a `<input value="...">` without pointless
round-tripping). Leaving the field blank on save now means "keep the
current secret unchanged" - enforced in `{identifier}ExtensionController::update()`,
which also refuses to enable SSO at all if no secret exists yet, either way.

### Why SSO login refuses to start over plain HTTP

OIDC's security model assumes TLS - the authorization code and tokens
cross the network in the clear otherwise. `assertSecureContext()`
(also in `OidcSettingsProvider`) checks `app.url` and refuses to initiate
the flow (clear error, not a silent no-op) unless it's `https://` or
`localhost`/`127.0.0.1` (exempted for local development). Called from
[`OidcRedirectController`](app/Http/OidcRedirectController.php) before
anything else happens.

### Why `admin/view.blade.php` is bare content - no `@extends`, no `@section` at all

[`admin/view.blade.php`](admin/view.blade.php) is plain, unwrapped HTML -
no `@extends`, no `@section`/`@endsection` of its own. This is verified
directly against Blueprint's own source
(`scripts/commands/extensions/install.sh`, function `InstallExtension`),
not guessed. At build time, Blueprint:

1. Copies its own template (`$__BuildDir/extensions/admin.blade.php`) into
   a working copy, then `sed`-substitutes `[name]`/`[description]`/
   `[version]`/`[icon]`/`[id]`/`[website]` placeholders into it. That
   template is what does `@extends('layouts.admin')`, renders the icon/
   name/version-badge/GitHub-link/gear-icon header, and opens
   `@section('content') @yield('extension.config') @yield('extension.description')`
   - note: **deliberately left open**, no `@endsection`.
2. Appends this extension's `admin/view.blade.php` **verbatim** right after
   that (`echo -e "$(<admin_view)\n@endsection" >> "$AdminBladeConstructor"`)
   - and appends the closing `@endsection` **itself**, right after our raw
     content.

So this file's content isn't a section of its own - it's the tail end of
Blueprint's already-open `content` section, closed by a directive Blueprint
appends after it, not by us. Two earlier, wrong attempts at this file both
caused real, confirmed breakage before landing on the correct bare-content
version:

- **Adding this file's own `@extends('layouts.admin')`** (left over from
  when this file used the wrong, broken `@extends('admin.layout')` - see
  "Compatibility" below) made the combined file contain two complete,
  back-to-back `@extends('layouts.admin')` templates. Confirmed live: the
  rendered page had two complete, stacked `<div class="wrapper">` page
  copies (same height, same content, one directly below the other) -
  invisible without scrolling, but very real in the DOM, and it broke the
  admin panel's own settings gear-icon button since its element `id`
  existed twice.
- **Wrapping the content in `@section('extension.config')`** looked more
  "correct" (it's literally the name of the thing being yielded) but
  doesn't work either: Blade populates a template's sections by executing
  it top-to-bottom in one pass, so `@yield('extension.config')` - which
  appears *earlier* in the combined file, inside Blueprint's own wrapper
  code - already runs (and finds nothing) before a `@section('extension.config')`
  further down in the same file ever gets a chance to define it. Only
  `@yield('extension.description')` rendered anything, because that one
  has a default value (`$EXTENSION_DESCRIPTION`) - the settings form itself
  never showed up at all.

### Why namespaces are hardcoded instead of using `{appcontext}`

Blueprint's docs describe `{appcontext}` as the placeholder for an
extension's PHP namespace (`Pterodactyl\BlueprintFramework\Extensions\{id}`).
In practice, on `beta-2026-06`, substituting it inside a `namespace ...;` or
`use ...;` statement corrupts the value: the generated `routes/blueprint/web/ssooidc.php`
came out as `use PterodactylBlueprintFrameworkxtensionsssooidc\Http\...` —
every backslash gone, and the `E` of `Extensions` missing. That's the exact
signature of GNU `sed`'s replacement-string handling: an unrecognized `\X`
escape silently drops the backslash and keeps the letter (`\B` → `B`), while
`\E` is a *recognized* GNU sed escape (end of a `\U`/`\L` case conversion)
that gets swallowed entirely (`\E` → nothing) — which is consistent with
Blueprint's placeholder engine doing a plain `sed` substitution without
escaping backslashes in the replacement text. Since `{appcontext}` is the
only placeholder whose value contains backslashes, it's also the only one
affected — `{identifier}` (plain `ssooidc`, no special characters) works
fine everywhere it's used (e.g. in route paths like `/extensions/{identifier}/redirect`).
The workaround: every `app/` file and `web.php` hardcodes
`Pterodactyl\BlueprintFramework\Extensions\ssooidc` directly instead of
writing `{appcontext}`, sidestepping the substitution entirely.

### Why `redirect_uri` is built from `app.url`, not `url()`

Pterodactyl typically sits behind a TLS-terminating reverse proxy that talks
plain HTTP to the panel internally. Without Laravel's `TrustProxies`
middleware explicitly trusting that proxy, `url()`/`request()`-based helpers
infer the scheme from the *internal* request and generate `http://...` URLs
even though the panel is only reachable over `https://`. Since the
`redirect_uri` sent to the IdP has to match the redirect URI registered
there **character-for-character**, that mismatch alone is enough for the IdP
to reject the login with a "Redirect URI Error" — confirmed against a real
authentik instance. `OidcSettingsProvider::extensionUrl()` and the admin
controller's callback-URL display both build the URL from `config('app.url')`
instead, which is admin-configured and scheme-correct regardless of how
`TrustProxies` is (or isn't) set up.

### Why no IdP subject (`sub`) is stored

The task this extension was built for explicitly calls for re-deciding the
account match on every login, not persisting a link. So
[`OidcUserProvisioningService`](app/Services/OidcUserProvisioningService.php) only ever looks accounts up by
email — if that changes on the IdP side, the *next* login simply creates (or
matches) a different account, by design.

### Why `root_admin` is fully IdP-controlled

Just like email/username/name, admin status is re-decided on **every**
single SSO login, for accounts that already existed before SSO was ever
enabled too - `OidcUserProvisioningService::resolve()` sets
`$user->root_admin = $isAdmin` unconditionally, no "only if configured"
carve-out. That's intentional: the whole point of centralizing auth at the
IdP is that group membership there is the single source of truth, not
something Pterodactyl's local DB should be allowed to disagree with.

The consequence: if `resolveIsAdmin()` can't evaluate a real answer - the
Admin claim name field is empty, the claim isn't present in the token, or
the configured value doesn't match - that's treated as **not an admin**,
same as if the IdP had explicitly said so. Concretely, in authentik:

1. The Admin claim *name* has to be a claim your provider actually puts in
   the token - by default that's usually `groups` (a list of the user's
   group names). Check under **Customization > Property Mappings** that a
   `groups` (or equivalent) scope mapping is attached to the provider, and
   that the scope is included in this extension's configured `Scopes`.
2. Set **Admin claim** to that claim name (e.g. `groups`) and **Admin claim
   value** to the exact group name that should grant admin (e.g.
   `pterodactyl-admin`) - and make sure the admin's authentik user is
   actually a member of that group.
3. Test with the exact account you're using before relying on it: log in
   via SSO once and confirm admin access didn't unexpectedly change.

Leaving Admin claim empty on purpose (no admin-status management via SSO at
all) still demotes every SSO-matched account to non-admin on login -
there's no "leave alone" mode. If that's not what you want, the claim needs
to be configured correctly, not left blank.

### Why 2FA is skipped for SSO logins

Pterodactyl's `LoginController::login()` only reaches the TOTP checkpoint
branch for password logins; the actual session login happens in
`AbstractLoginController::sendLoginResponse()` via
`Auth::guard()->login($user, true)` after `session()->regenerate()`.
[`OidcCallbackController`](app/Http/OidcCallbackController.php) calls that exact same guard login, just never
routes through the checkpoint branch — not a bypass of a check, just a
different (and for federated logins, correct) login path.

### Why `Authentication.Container.BeforeContent`

It's the only `Components.yml` slot on the login page. There's no supported
way to remove Pterodactyl's native login form itself (`LoginContainer.tsx` has
no stable class names to target). When "hide password login" is enabled in
the admin settings, [`SsoAuthOverlay.tsx`](dashboard/components/SsoAuthOverlay.tsx) instead covers the screen with a
full-viewport overlay and redirects immediately, rather than trying to touch
the native form at all.

### Why there's a `?auto_sso=0` escape hatch

"Hide password login" auto-redirects every visit to the login page - useful
until the IdP is down, misconfigured, or otherwise locking everyone out,
with no way back to the form underneath. Appending `?auto_sso=0` to the
login page URL disables only the automatic redirect - the SSO button is
always shown regardless of this parameter, this just stops it firing on
its own and leaves the classic form usable alongside it. Not a new security
bypass: "hide password login" was always a UI-only decision, `/auth/login`
itself was never actually disabled server-side. Shown directly under the
"hide password login" checkbox in the admin settings, not just documented
here.

### Why the logout button is patched (RP-Initiated Logout)

Pterodactyl's own logout only ends the *panel* session. There are actually
**two** separate logout buttons with near-identical logic to patch: the
client dashboard's (`NavigationBar.tsx`'s `onTriggerLogout` does
`POST /auth/logout` then `window.location = '/'`) and the admin panel's
(an inline `<script>` block in `layouts/admin.blade.php` doing the same
POST, then `window.location.href` to the login route). Either way, the
IdP's browser session stays alive, so with "hide password login" enabled,
hitting the login page again silently re-authenticates via the still-active
IdP session — logging out never actually logs you out. There's no
`Components.yml` slot to change what an *existing* button does (only where
to add new components), so [`data/install.sh`](data/install.sh) patches
both files via `sed`, redirecting to `/extensions/ssooidc/logout` instead
— same technique used for [out-of-scope
changes](https://blueprint.zip/docs/concepts/scripts) generally. Each
patch is anchor-checked before applying and marker-checked after (aborts
loudly instead of silently no-op'ing if Pterodactyl's source no longer
matches), and [`data/remove.sh`](data/remove.sh) reverts both exactly.
[`OidcLogoutController`](app/Http/OidcLogoutController.php) then performs
RP-Initiated Logout, but only for sessions that were actually established
via SSO (see "Why `id_token_hint` comes from a DB row" below) - a
password-login user's logout was never an SSO concern in the first place,
and just falls straight back to the panel root. For an actual SSO session,
if the provider's discovery document exposes an `end_session_endpoint`
(authentik, Keycloak and most others do), it redirects there with
`post_logout_redirect_uri` set back to the panel root; otherwise (or if the
IdP is unreachable, or SSO is disabled) it just falls back to `/`, same as
the original behavior.

### Why `id_token_hint` comes from a DB row, referenced by a tiny cookie

`id_token_hint` (the original ID token) is spec-*recommended* on RP-Initiated
Logout requests, and some providers require it before they'll honor
`post_logout_redirect_uri` at all (confirmed working without it against
authentik, but that's not guaranteed for every provider). The problem:
`OidcLogoutController` only runs *after* Pterodactyl's own `/auth/logout`
has already destroyed the Laravel session (see above) - by then, anything
stored via `$request->session()` is gone.

The first version of this solved it by putting the id_token directly into a
cookie, and that broke logins behind a reverse proxy: a JWT can be a few
hundred bytes to 1-2KB depending on how many claims/groups the provider
sends, and Laravel's `Pterodactyl\Http\Middleware\EncryptCookies`
AES-encrypts every cookie by default on top of that - inflating it enough
to push the combined `Set-Cookie` headers past a reverse proxy's response
header buffer (confirmed against a live deploy behind Nginx Proxy Manager:
`502 upstream sent too big header` right after login, then `invalid_grant`
on the inevitable reload, since the single-use authorization code had
already been consumed by the request whose response never reached the
browser). Bypassing `EncryptCookies` via plain `setcookie()` only postponed
the problem to whenever a provider sends an unusually large token.

The actual fix is a reference-token pattern: the id_token is stored
server-side in the `ssooidc_sessions` row created at login (migration
`2026_07_23_000005_...`) - a table that already exists for Back-/Front-Channel
Logout lookups - and the cookie (`ssooidc_idth`) holds only that row's
`session_id`, a small fixed-size opaque string regardless of how chatty the
provider's claims are. `OidcLogoutController::consumeIdTokenHint()` looks
the row up by it, reads the stored id_token, and deletes the row either
way (found or not) - single-use, same as before, just without an
ever-growing cookie. Still read via the raw `$_COOKIE` superglobal rather
than `$request->cookie()`/`Cookie::make()`: keeping this specific cookie
outside `EncryptCookies` entirely means its size is now trivial and
predictable no matter what, rather than merely "usually small enough."

If you're behind a reverse proxy, it's still worth increasing its response
header buffer as general headroom (other cookies, or future changes, could
still add up) - e.g. for Nginx Proxy Manager, add to the Proxy Host's
Advanced tab:

```nginx
proxy_buffer_size 16k;
proxy_buffers 4 16k;
proxy_busy_buffers_size 32k;
```

### Why there's also Back-Channel Logout, and a real DB table for it

RP-Initiated Logout only covers the case where the *browser* tells
Pterodactyl to log out. It doesn't cover sessions ending elsewhere with no
browser involved. Verified directly against authentik's own source
(`authentik/providers/oauth2/signals.py`): a `pre_delete` signal on its
`AuthenticatedSession` model fires whenever a session ends for *any*
reason - authentik's own logout flow, an admin ending a session, expiry -
and dispatches a POST with a signed `logout_token` to the provider's
configured "Logout URI". This is [OIDC Back-Channel Logout
1.0](https://openid.net/specs/openid-connect-backchannel-1_0.html), and
authentik's implementation sends exactly `POST` with
`Content-Type: application/x-www-form-urlencoded` and a `logout_token`
field (`authentik/providers/oauth2/tasks.py`), which
[`OidcBackchannelLogoutController`](app/Http/OidcBackchannelLogoutController.php)
(`/extensions/ssooidc/backchannel-logout`) expects.

This request is server-to-server with no Pterodactyl session or CSRF token
attached. `php artisan route:list` shows Blueprint's `requests.routers.web`
routes carrying only its own `blueprint` middleware - which turned out to
be misleading: Laravel's full `web` middleware group (including
`Pterodactyl\Http\Middleware\VerifyCsrfToken`) still applies underneath it,
confirmed the hard way when a real authentik instance got back `HTTP 419`.
[`web.php`](web.php) exempts just this one route with
`->withoutMiddleware(VerifyCsrfToken::class)` - no core file patch needed,
`Pterodactyl\Http\Middleware\VerifyCsrfToken` is a stable, existing class.

To act on that notification, Pterodactyl's session has to be found by IdP
session id (`sid`) - and Laravel's session store has no way to look up "the
session belonging to this external id". So
[`OidcCallbackController`](app/Http/OidcCallbackController.php) records a
`sid`/`sub` → Laravel-session-id mapping in a real table
(`ssooidc_sessions`, via the migration in `migrations/`) on every login -
`BlueprintExtensionLibrary`'s `dbGet`/`dbSet` is a flat one-record-per-key
store, not suited for a growing, queryable set of rows. On a valid
back-channel notification, the matching session(s) are destroyed
driver-agnostically via `app('session')->driver()->getHandler()->destroy()`
(works whether Pterodactyl's `SESSION_DRIVER` is `file`, `database`,
`redis`, ...), then the row is deleted. Rows are only ever cleaned up when
consumed this way; ones that are never followed by a back-channel
notification (the common case - most users just close their browser) are
opportunistically pruned after 30 days rather than kept forever.

The `logout_token` is verified the same way as an `id_token` (signature via
JWKS, issuer, audience), but additionally must carry the
`http://schemas.openid.net/event/backchannel-logout` event claim and must
**not** carry a `nonce` - that's the one property the spec uses to tell the
two token types apart at the wire level.

This is entirely optional and additive: if the IdP has no "Logout URI" /
"Backchannel Logout URI" configured, nothing calls this endpoint and
everything else keeps working exactly as before.

### Why Back-Channel Logout also rotates `remember_token`

Killing the session row alone isn't a full logout. `Auth::guard()->login($user, true)`
in `OidcCallbackController` sets a "remember me" cookie (the `true` matches
Pterodactyl's own `sendLoginResponse()`) - and a browser holding a still-valid
one gets **silently re-authenticated with a brand new session** on its very
next request, completely bypassing the session that was just destroyed
(confirmed against a live authentik instance: the backchannel notification
correctly found and deleted the tracked session, and the browser still
looked logged in afterward). RP-Initiated Logout doesn't have this problem -
Pterodactyl's own `/auth/logout` already rotates the remember token as part
of its normal `Auth::guard()->logout()` call - but Back-Channel Logout has
no browser/session context to piggyback on. So
`ssooidc_sessions` also records the Pterodactyl `user_id` at login
(migration `2026_07_23_000002_...`), and
[`OidcBackchannelLogoutController`](app/Http/OidcBackchannelLogoutController.php)
rotates `remember_token` for every affected user alongside destroying their
session(s).

### Back-Channel Logout is asynchronous - a delay is expected

Unlike RP-Initiated Logout (synchronous, browser-driven - the panel session
is gone before the redirect back even completes), Back-Channel Logout is a
server-to-server notification dispatched through the IdP's own task queue
(authentik uses `dramatiq`). There is an inherent, spec-expected gap between
"session ended at the IdP" and "notification actually processed here" -
observed as roughly 30 seconds against a live authentik instance. A
reload performed *immediately* after logging out at the IdP can therefore
still show an authenticated session; that's normal, not a bug. Give it a
few seconds before concluding the notification failed - check the Laravel
log for `ssooidc backchannel-logout received` (logged with `matched_rows`)
and authentik's own System Tasks (`send_backchannel_logout_request`) before
assuming something's broken.

### Why there's also Front-Channel Logout, and why it's the fallback, not the default

Some providers only support one logout method at a time (authentik's OAuth2
provider has a single "Logout Method" choice, Backchannel *or* Frontchannel
- not both simultaneously) or don't implement Back-Channel Logout at all.
[`OidcFrontchannelLogoutController`](app/Http/OidcFrontchannelLogoutController.php)
(`/extensions/{identifier}/frontchannel-logout`) covers that case: per the
[Front-Channel Logout 1.0](https://openid.net/specs/openid-connect-frontchannel-1_0.html)
spec, the IdP loads this URL as a hidden iframe on its own logout page,
passing `iss` and `sid` as query parameters - no request body, no
signature. It shares the exact same session-killing logic as Back-Channel
Logout (extracted into the `KillsSsoSessions` trait), just triggered
differently - and it fires synchronously as part of the IdP's logout page
load, without Back-Channel's async task-queue delay.

The tradeoffs that make Back-Channel the recommended default whenever a
provider offers a choice:

- **No signature.** Unlike a `logout_token`, there's nothing here to
  cryptographically verify. Only the high-entropy `sid` (a 64-character
  SHA-256 hash - not realistically guessable) is trusted for the session
  lookup; `subject` alone is deliberately *not* accepted as a fallback the
  way it is for the signed Back-Channel `logout_token`, since a subject
  value is far more guessable from an unauthenticated GET request. `iss` is
  checked too, but that's only a sanity check, not real security - it's
  just another query parameter, sent unauthenticated.
- **Browser third-party restrictions.** This endpoint has to actually load
  successfully as a cross-origin iframe on the IdP's page - increasingly
  blocked by browser tracking-protection features (Safari ITP, Firefox
  ETP, ...), independent of anything this extension does.
- **`X-Frame-Options` / CSP `frame-ancestors`.** If Pterodactyl's own stack
  or reverse proxy sends a restrictive `X-Frame-Options`/CSP globally, this
  endpoint can't be framed by the IdP's origin at all, and the iframe just
  silently fails to load - check for that if Front-Channel Logout doesn't
  seem to fire, since our controller can't detect or work around headers
  added elsewhere in the response pipeline.

### Why `remove.sh` cleans up the database itself

`blueprint -remove` only deletes files - views, routes, the app folder,
router files, and the extension's `.blueprint/extensions/ssooidc` folder.
Confirmed by testing a full install → remove cycle and inspecting the
database afterwards: it does **not** run the extension's migrations'
`down()` methods. Both the `settings` table (all 15 `ssooidc::*` rows,
including the encrypted client secret) and the `migrations` tracking table
(all 6 rows for this extension's migration files) were still present after
removal, and the migration `.php` files themselves were never deleted from
`database/migrations/` either - so nothing was actually rolled back, only
un-tracked-as-installed at the extension level.

Left alone, this means "removing" the extension doesn't really remove it:
stale settings (including a leftover encrypted client secret and any
provisioned SSO session data in `ssooidc_sessions`) stay in the database
indefinitely, which is both untidy and a real data-retention concern.
`data/remove.sh` now does this cleanup explicitly instead of relying on a
rollback mechanism that Blueprint never triggers: it deletes the
`ssooidc::*` settings rows, drops the `ssooidc_sessions` table, removes the
6 migration tracking rows by exact filename, and deletes any leftover
migration `.php` files from `database/migrations/`. This also matters for
reinstalling cleanly afterwards - stale `migrations` rows would otherwise
make Laravel believe those migrations already ran and skip them, silently
leaving the fresh install without its default settings or its
`ssooidc_sessions` table.

The cleanup runs through `php artisan tinker --execute=...` rather than a
plain SQL client, since that needs no DB driver/credentials handling of its
own - it reuses whatever connection Laravel is already configured with.
One snag found while testing this exact call during removal: tinker's REPL
(psysh) writes its config/history to `$HOME/.config/psysh` on startup and
aborts hard if that's not writable - which it wasn't in this environment
(`Writing to directory /var/www/.config/psysh is not allowed`), silently
skipping the whole cleanup block before it ever ran. `remove.sh` now points
`HOME` at a throwaway `mktemp -d` directory just for that one call, leaving
the real environment untouched.

## Configuration

All settings live under `Admin > Extensions > OIDC SSO Login`:

| Setting | Description |
|---|---|
| Enabled | Turns SSO login on/off globally |
| Hide password login | Skip the native form, redirect straight to the IdP |
| Button text | Text of the SSO button shown on the login page |
| Issuer URL | OIDC issuer; `{issuer}/.well-known/openid-configuration` is fetched automatically |
| Client ID / Client Secret | Confidential client credentials. The secret is stored encrypted and never shown again after saving - leave it blank on later saves to keep the current one. |
| Scopes | Defaults to `openid profile email` |
| Email / Username / First name / Last name claims | Claim names to read from the ID token |
| Admin claim / Admin claim value | A user is `root_admin` if this claim contains (or equals) this value. Evaluated fresh on **every** SSO login, for new *and* existing accounts alike - see "Why `root_admin` is fully IdP-controlled" below before enabling SSO for an account that's already an admin. |
| Requested ACR values | Optional. Sent as `acr_values` in the authorization request - a hint the provider may ignore. Not enforcement, see "Requires AMR values" for that. |
| Required AMR values | Optional, comma-separated (e.g. `mfa,otp`). If set, login is rejected unless the id_token's `amr` claim contains at least one of these. Left empty, nothing is checked. |

## Setup

1. **Build/install the extension** — see "Installation (development)"
   below for the exact commands.
2. **Register a confidential OIDC client** at your provider (authentik,
   Keycloak, Azure AD, ...). Open `/admin/extensions/ssooidc` in Pterodactyl
   first to get the exact **Redirect / Callback URL** to register there.
3. **Fill in Issuer URL, Client ID and Client Secret** on the extension's
   admin page. The issuer's `.well-known/openid-configuration` is fetched
   automatically — no separate endpoint configuration needed.
4. **Check the Claim Mapping section** matches what your provider actually
   sends (defaults: `email`, `preferred_username`, `given_name`,
   `family_name`). Optionally set an Admin claim name/value if group
   membership at the IdP should control Pterodactyl's admin flag.
5. **Optional**: set the provider's logout callback ("Logout URI" /
   "Backchannel Logout URI" / "Frontchannel Logout URI", depending on what
   it supports) to the Back-/Front-Channel Logout URL shown on the same
   admin page, and set Requested ACR / Required AMR values if you want to
   enforce a specific authentication strength.
6. **Check "Enable SSO login"** and save. Optionally also check "Hide
   username/password login" to redirect straight to the IdP.
7. Test end-to-end: log in via the new SSO button (or the auto-redirect),
   confirm the account is created/matched correctly, then log out again and
   confirm it also ends the session at the IdP.

See the `## Configuration` table and the `### Why ...` sections below for
what each setting actually does and why it's built the way it is.

## Installation (development)

```bash
# Enable developer mode in the admin panel under /admin/extensions, then:
rm -rf /var/www/pterodactyl/.blueprint/dev/*
cp -r ssooidc/* /var/www/pterodactyl/.blueprint/dev/
cd /var/www/pterodactyl
blueprint -build
```

`.blueprint/dev` is always flat in Blueprint (one extension per dev folder)
— the files go directly into it, not into a further `ssooidc/` subfolder.

After building, set the callback URL shown on the extension's admin page as
the redirect URI at the OIDC provider, then fill in issuer/client
credentials and enable it. Optionally, also set the provider's "Logout URI"
/ "Backchannel Logout URI" (if it has one) to the backchannel-logout URL
shown on the same admin page - not required for normal login/logout, only
for Back-Channel Logout (see "How it works" above).

## Uninstallation

```bash
blueprint -remove ssooidc
```

`data/remove.sh` reverts the `NavigationBar.tsx` and `admin.blade.php`
logout patches exactly (see above), explicitly cleans up the database (see
"Why `remove.sh` cleans up the database itself" below), and removal
continues as usual: the admin page, routes and login-page component are
dropped. Accounts that were provisioned via SSO keep existing (with a
random, unusable password), so a password reset is needed if someone needs
to log into one of them without SSO afterwards.

## Testing checklist

- [ ] Open `/admin/extensions/ssooidc`, view page source, search for "OIDC
      SSO Login" → appears once (title/header), not twice. Confirm in the
      browser console: `document.querySelectorAll('div.wrapper').length`
      → `1`.
- [ ] Click the settings gear icon top-right of the extension's admin page
      → works (this silently broke while the page was duplicated, since
      its element `id` existed twice in the DOM).
- [ ] Log in via SSO behind the real reverse proxy (not `php artisan serve`)
      and time the redirect from callback to landing in the dashboard → no
      `503`/timeout, even on a cold connection to the IdP.
- [ ] Log in via SSO behind a reverse proxy with default/small buffer sizes
      → lands in the dashboard directly, no `502 upstream sent too big
      header`. Check the `ssooidc_idth` cookie's raw value in dev tools -
      it should be a short session ID (~40 chars), not a JWT or an
      encrypted blob.
- [ ] After logging in, check `ssooidc_sessions` directly
      (`SELECT session_id, id_token FROM ssooidc_sessions`) → the row for
      that login has a non-empty `id_token`.
- [ ] With "hide password login" enabled, open `/auth/login?auto_sso=0` →
      plain classic form shows alongside the SSO button, no auto-redirect.
- [ ] Same URL without `?auto_sso=0` → auto-redirects as usual.
- [ ] On the plain login page (hide password login *off*), the SSO button
      sits between the login button and the "forgot password" link, not
      above the whole form.
- [ ] Log in with plain username/password (no SSO, 2FA if enabled) → click
      logout → lands back on the panel directly, never redirected to the
      IdP (this used to happen for *any* logout whenever SSO was merely
      enabled, regardless of how the user logged in - fixed).
- [ ] Log out from the **admin panel** (not just the client dashboard) after
      an SSO login → same RP-Initiated Logout behavior as the client
      dashboard's logout button.
- [ ] Log in via SSO, check the browser's dev tools (Application/Storage →
      Cookies) → `ssooidc_idth` is present, `httpOnly`, `secure`.
- [ ] Log out via the Pterodactyl button → check a network capture of the
      redirect to the IdP's `end_session_endpoint` → `id_token_hint` is
      present in the query string, and the `ssooidc_idth` cookie is gone
      afterward.
- [ ] Log in with plain username/password (no SSO) → log out → still works
      exactly as before (redirects through `/extensions/ssooidc/logout`,
      which falls back to `/` since there's no `id_token_hint` cookie for a
      non-SSO session).
- [ ] After saving settings, check the `settings` table directly
      (`SELECT value FROM settings WHERE key = 'ssooidc::client_secret'`)
      → value is unreadable ciphertext, not the plaintext secret.
- [ ] Save the settings form with the Client Secret field left blank → SSO
      keeps working (existing secret wasn't wiped), and the admin page still
      shows the "already set" placeholder, never the real value.
- [ ] Try enabling SSO with no Client Secret ever configured → rejected
      with a clear alert, not silently enabled.
- [ ] Temporarily set `APP_URL` to an `http://` (non-localhost) address and
      clear the config cache → hitting `/extensions/ssooidc/redirect`
      fails with a clear "refused: not https" error instead of proceeding.
- [ ] Login with a new email → account is created just-in-time, redirected
      into the dashboard, no 2FA prompt.
- [ ] Check the IdP's own auth/token endpoint logs (or a network capture)
      during a login → the authorization request carries `code_challenge`
      + `code_challenge_method=S256`, and the token request carries a
      matching `code_verifier`.
- [ ] Login with the email of an existing (password-based) account → logs
      into that account, fields get updated.
- [ ] Toggle the admin claim's group membership at the IdP → `root_admin`
      changes on the next login accordingly, for both new *and* existing
      accounts (including one that was `root_admin` before SSO existed).
- [ ] Log in via SSO with an account that is *not* in the admin group at
      the IdP → confirm it's correctly non-admin, even if that email
      previously belonged to a `root_admin` account.
- [ ] Enable "hide password login" → `/auth/login` redirects straight to the
      IdP, no visible form.
- [ ] An account with TOTP 2FA enabled logs in via SSO → no 2FA prompt.
- [ ] Username collision (two accounts would derive the same username) → the
      second account gets a numeric suffix, the first account's login is
      unaffected.
- [ ] Log out after an SSO login → lands back on the (real) login page /
      IdP login prompt, not silently signed back in. With "hide password
      login" enabled, this means seeing the IdP's own login form again, not
      an instant bounce back into the dashboard.
- [ ] `blueprint -remove ssooidc` → `NavigationBar.tsx`'s logout redirect is
      back to plain `/` (check the marker comment is gone).
- [ ] Set the backchannel-logout URL in the IdP, log in via SSO, then log
      out **at the IdP directly** (not via Pterodactyl) → wait ~30 seconds
      (this is async, see "Back-Channel Logout is asynchronous" above -
      an immediate reload can still look logged in, that's expected) →
      refresh the dashboard without touching Pterodactyl at all → shows the
      login page.
- [ ] A `logout_token` replayed with a made-up/expired signature, or one
      missing the backchannel-logout event claim, or one that (incorrectly)
      carries a `nonce` → rejected with `400 invalid_request`, no session
      touched.
- [ ] Set "Required AMR values" to something the IdP won't send (e.g.
      `mfa` while only password auth was used) → login is rejected with a
      clear error, no account created/updated, no session.
- [ ] Set it to a value the IdP *does* send (check the id_token's `amr`
      claim first) → login succeeds normally.
- [ ] After a successful login, check the IdP's own token/session admin
      view → the `access_token` issued for that login shows as revoked.
- [ ] Temporarily rename one of the configured claim names to something the
      provider doesn't actually send (forcing a miss) → login still
      succeeds and the field is populated correctly, sourced from
      `userinfo_endpoint` instead of the id_token.
- [ ] Switch the IdP's logout method to Frontchannel and point it at the
      frontchannel-logout URL shown on the admin page → log in via SSO, log
      out at the IdP directly → session dies immediately (no ~30s
      Back-Channel-style delay), *if* the iframe actually loads (check the
      browser's network tab for the request if it doesn't - see the
      `X-Frame-Options`/CSP caveat above).

## Compatibility

Last verified against:

- Pterodactyl Panel: `1.0-develop` branch — the admin view was confirmed to
  extend `layouts.admin` (not `admin.layout`), and `AdminFormRequest`
  already declares its own `normalize()`, so subclasses must not redeclare
  it under that name — both confirmed against a live panel (PHP 8.4.23,
  Laravel 11.47.0). The panel also needs `TrustProxies` configured (or
  `APP_URL` set correctly and its config cache rebuilt) when running behind
  a TLS-terminating reverse proxy — see "Why `redirect_uri` is built from
  `app.url`" above.
- Blueprint Framework: `beta-2026-06` (current stable release, matching
  `info.target` in `conf.yml`).
- `lcobucci/jwt`: `5.6.0`, as actually installed by Pterodactyl's
  `composer.lock` (confirmed via `composer show lcobucci/jwt` on a live
  panel). `Configuration::forUnsecuredSigner()` doesn't exist in this
  version (only `forAsymmetricSigner`/`forSymmetricSigner` do), so reading
  the unverified `kid` header is done with a manual base64url + JSON decode
  instead (`OidcClientService::peekKid()`). `Lcobucci\Clock\SystemClock` is
  also not available - it lives in `lcobucci/clock`, which is only a *dev*
  dependency of `lcobucci/jwt` and isn't installed in production. The
  `LooseValidAt` constraint only needs a `Psr\Clock\ClockInterface`
  though (a real, non-dev dependency), so `OidcClientService::systemClock()`
  implements that interface directly with a one-line anonymous class
  instead of pulling in `SystemClock`.
- `resources/scripts/components/NavigationBar.tsx`: the patched line
  (`window.location = '/';` inside `onTriggerLogout`) was confirmed verbatim
  against the `develop` branch source. If a future panel version changes
  that file, `install.sh`/`update.sh` fail loudly (`FATAL`, non-zero exit)
  instead of silently skipping the patch.

Since ID-token verification relies on `lcobucci/jwt` already being a
Pterodactyl dependency, a future panel version dropping or majorly changing
that package's API would break signature verification again.
