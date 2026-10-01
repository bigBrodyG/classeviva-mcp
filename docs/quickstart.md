# Quickstart

Cloudflare Worker exposing the ClasseViva register to Claude over MCP, with
Cloudflare Access as the identity provider.

The Worker plays two roles at once: it is an **OAuth server** to MCP clients, and
an **OAuth client** to Cloudflare Access. That is the "SaaS-managed" shape
described in [Cloudflare's own guide][1]. Because it exposes `/register` (dynamic
client registration), claude.ai and the desktop apps connect with just a URL — no
client ID or secret to paste in.

[1]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/

> This is a step-by-step runbook for deploying your own instance, with
> placeholder values (`mcp.example.com`, `you@example.com`) throughout. For the
> condensed version, see the "Configure your own" section of the
> [README](../README.md).

---

## 1. Create the Access for SaaS application

In **Zero Trust → Access → Applications → Add an application → SaaS**:

| Field | Value |
|---|---|
| Application | any name, e.g. `ClasseViva MCP` |
| Authentication protocol | **OIDC** |
| Redirect URL | `https://mcp.example.com/callback` |
| Scopes | `openid`, `email`, `profile` |

Add `http://localhost:8788/callback` as a second redirect URL if you want the flow
to work locally too — unlike a GitHub OAuth App, Access accepts several.

Save, then copy five values from the page:

- Client ID
- Client secret
- Authorization endpoint
- Token endpoint
- Key endpoint (JWKS)

> Take the **Authorization endpoint**, the one ending in `/authorization`. The page
> also shows a discovery URL ending in `/.well-known/openid-configuration`, and
> picking that one by mistake sends the login to a 404 with no useful error.

Under **Policies**, add one that allows your email — and, if more than one person
will use this deployment, everyone else's too (a comma-separated list of emails,
or an Include rule per person). With **One-time PIN** as the login method you get
a code by email and need no third-party identity provider.

This policy and `ALLOWED_EMAILS` (step 3) are two separate gates that both have to
list an identity. Forgetting one while setting the other is the single most common
way a second person ends up unable to sign in — see
[Troubleshooting](#troubleshooting).

## 2. Fill in `.env`

```bash
cp .env.example .env
```

Nine values: the five from step 1, two you generate, and `CLASSEVIVA_ID` /
`CLASSEVIVA_PASSWORD`.

```bash
openssl rand -hex 32    # COOKIE_ENCRYPTION_KEY
openssl rand -hex 32    # LINK_SIGNING_KEY
```

Those last two are **not** the login anyone actually signs in with — every person
enters their own ClasseViva ID and password in a form shown after Access (step 6).
They exist only as a fallback for an OAuth grant minted before that form existed,
so any non-empty placeholder satisfies the deploy script; it does not need to be a
working login.

**`.env` is the source of truth for production secrets.** The deploy script is
`wrangler deploy --secrets-file .env`, so `npm run deploy` uploads them along with
the code — there is no separate `wrangler secret put` step.

Three consequences worth knowing:

- A missing `.env` makes the deploy **fail outright** with `ENOENT`.
- Everything in the file is uploaded, so keep it to those nine names.
- Uploading is additive: secrets already on the Worker but absent from the file are
  preserved, not deleted.

`.env` also feeds `npm run dev`, so the same file covers local development.
`.env` is gitignored — never commit it.

## 3. Set who is allowed in, and where

Access proves *who* is knocking; `ALLOWED_EMAILS` in `wrangler.jsonc` decides
whether they get in. `PUBLIC_HOSTNAME` and `MCP_ROUTE` decide where the server
answers.

```jsonc
"vars": {
    "ALLOWED_EMAILS": "you@example.com,someone.else@example.com",
    "PUBLIC_HOSTNAME": "mcp.example.com",
    "MCP_ROUTE": "/classeviva"
}
```

Empty `ALLOWED_EMAILS` denies everyone — it fails closed. A comma separates
several addresses, for the people sharing this deployment; each of them still
needs their own entry in the Access application's policy from step 1; and each
signs in with their own ClasseViva login (step 6) — there is no account shared
between them. Unlike secrets, these are **`vars`**, so changing one requires a
redeploy; a deploy also wipes and rewrites them, so never add a var from the
Cloudflare dashboard expecting it to survive.

`PUBLIC_HOSTNAME` is Host-header validation. `localhost` and `*.workers.dev` are
allowed by default; a custom domain is not, and must be named here or every request
is rejected.

`MCP_ROUTE` is the path the MCP endpoint is served at, `/classeviva` by default.
Most deployments can leave it alone; change the value if you want a different URL
segment, but keep the key present.

## 4. Deploy

```bash
npm install
npm run cf-typegen   # regenerates worker-configuration.d.ts from wrangler.jsonc
npm run type-check
npm run deploy
```

One command pushes code, config and secrets. The first deploy also creates the DNS
record for your custom domain, which needs that domain's zone to be on the same
Cloudflare account — otherwise drop the `routes` block and `PUBLIC_HOSTNAME`
and use the `*.workers.dev` URL the deploy prints.

Confirm the endpoints are wired and the door is locked:

```bash
curl -s https://mcp.example.com/.well-known/oauth-authorization-server | head -c 200
# expect JSON naming /authorize, /token and /register

curl -s -o /dev/null -w '%{http_code}\n' -X POST https://mcp.example.com/classeviva \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
# expect: 401
```

A `200` on the second would mean the server answers without authentication. Stop
and fix that before going further.

`npx wrangler secret list` should show exactly nine names. Anything else is a
leftover and can be removed with `wrangler secret delete`.

## 5. Connect

The MCP endpoint is `https://mcp.example.com/classeviva` by default — the path
matters, the bare domain is not it. Substitute your own domain and, if you changed
`MCP_ROUTE`, your own path.

**claude.ai, Desktop, Cowork, mobile:** Settings → Connectors → **Add custom
connector** → paste the URL → Add. Leave the advanced OAuth fields empty;
`/register` handles it. You will be sent to Access to sign in.

**Claude Code:**

```bash
claude mcp add --transport http classeviva https://mcp.example.com/classeviva
```

The browser opens for the Access login. No header, no token to paste.

These two are separate: a connector added on claude.ai syncs down into Claude Code,
but one added with `claude mcp add` stays local. If `claude mcp list` shows the
server prefixed with `claude.ai` and "Needs authentication", that is the web
connector, not the local one.

## 6. Sign in with ClasseViva

Past the Access OTP, you land on a form: ClasseViva ID and password, the same
ones used in the ClasseViva app. Submitting it logs in against ClasseViva itself
before anything is minted — a wrong ID or password re-shows this same form with
an error instead of failing three steps later inside the first tool call.

If that login is a Genitore account linked to more than one child, a second
screen lists them and asks which one this sign-in is for. A single-profile login
never sees this screen. Either way, the choice is bound to this OAuth grant: the
next connection from the same client reuses it without asking again — a client
holding a still-valid token goes straight back to tool calls and never touches
this form again. To force it fresh (changed password, wrong child picked, a
different login entirely), **remove** the connector rather than reconnecting it
(claude.ai: Settings → Connectors → remove; Claude Code: `claude mcp remove
classeviva`), then add it back.

Each person who connects goes through this once, with their own ClasseViva
credentials — not the ones in `.env`.

## 7. Try it

> Quali compiti ho per la prossima settimana?

That exercises the whole chain: Access, the allowlist, the ClasseViva login,
`agenda`, and the subject lookup through `profile`.

---

## Troubleshooting

```bash
npx wrangler tail                    # live
npx wrangler tail --status error     # failures only
```

| Symptom | Cause |
|---|---|
| "L'utente non è abilitato" / access denied **before** reaching the sign-in form | This is Cloudflare Access's own page, not the Worker's — the identity is missing from the Access application's **policy** (step 1). `ALLOWED_EMAILS` is a second, separate gate checked only after Access lets someone through; fixing one does not fix the other. |
| `not authorised to use this server` | This one *is* the Worker's own message — the Access email is not in `ALLOWED_EMAILS` (step 3). Fix it and **redeploy** — it is a var. |
| Login lands on a 404 at cloudflareaccess.com | `ACCESS_AUTHORIZATION_URL` holds the discovery URL instead of the one ending `/authorization`. |
| Redirect URL mismatch at Access | The redirect in the SaaS app must be exactly `https://mcp.example.com/callback`, no trailing slash. |
| `tools/list` returns an empty list | A token exists but the identity is outside the allowlist. The server fails closed by registering nothing. |
| `failed to verify token` | `ACCESS_JWKS_URL` is wrong, or points at a different Access app than the client ID. |
| The sign-in form (or any custom route you add) returns a bare `401`, with nothing in `wrangler tail` for it | Its path starts with `MCP_ROUTE` (`/classeviva`). `workers-oauth-provider` matches API routes with `startsWith` and swallows it into the OAuth-gated MCP handler before this repo's code runs — see the note in the [README](../README.md#attachments). Rename the route so it does not start with the MCP prefix. |
| "Could not reach ClasseViva — try again" right after entering a correct ID and password | Only possible if you forked the sign-in flow and call `ensureSession` before `discoverProfiles` — a Genitore login linked to more than one child answers with `choices`, not a token, and `ensureSession` cannot parse that. Check `discoverProfiles` for that login first; only fall back to `ensureSession` when it returns `null`. |
| `403` on an attachment link | Links expire after an hour. Call `noticeboard` again for a fresh one. |
| `400` on an attachment link | The URL lost its `?exp=…&sig=…` query string. |
| `item must first be read` | Should not happen — the Worker opens the notice and retries. If you see it, the retry path broke. |
| `ClasseViva rejected that ID or password` | The ID or password entered in the sign-in form is wrong. Re-enter it; this does not touch `.env`. |
| `ClasseVivaError … 422` from a tool call, for an identity that was already signed in | That person's ClasseViva password changed since they signed in. They need to **remove** the connector and add it back to re-enter it (see [step 6](#6-sign-in-with-classeviva)) — reconnecting alone reuses the old password. Nothing to fix in `.env` unless the identity relying on the `CLASSEVIVA_ID`/`CLASSEVIVA_PASSWORD` fallback is the one affected. |
| `ClasseVivaError … 122` | Date range outside the current school year, or ending later than today. |

Remember that MCP reports tool failures **inside** the response body with HTTP
`200`. A Cloudflare log showing `status: 200` and `outcome: ok` only means the
request authenticated and the Worker did not crash — to know whether a tool
succeeded, look for `isError` in the body.

## Day to day

```bash
npm run cf-typegen        # after any change to wrangler.jsonc's vars
npm run type-check        # the only automated check there is
npm run dev               # localhost:8788, hot reload
npm run deploy            # code + config + secrets
```

There is no test suite. After changing anything that touches access control, re-run
the two curl checks from step 4 against the deployed Worker: unauthenticated
`/classeviva` must be `401`, and an unsigned `/attachment/CF/1/1` must be `400`.

`.env` **shadows** nothing by default, but if you create a `.dev.vars` file it
shadows `.env` completely rather than merging — every value the Worker needs would
have to be in it.
