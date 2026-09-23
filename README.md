# hangtime

Cloudflare Workers + Durable Objects port of `morningstimer` — tracks moose-carcass
aging ("mörning") using degree-day accumulation from two Shelly BLU H&T sensors
(outside / cold room).

Unlike the original Ruby app (which listened for UDP pushes on a Raspberry Pi),
this version expects a Shelly Gen2+ device to open an **outbound WebSocket
connection** to `/ws?token=<GATEWAY_TOKEN>` (a built-in Gen2+ firmware feature,
`Ws.SetConfig`). That device runs `shelly/ble-hangtime-relay.js` (in the
`hallfjallet` repo, alongside the other Shelly device scripts) — a script that
scans for BTHome BLE adverts from the two BLU H&T sensors and re-emits them as
a `bthome_report` script event, which the outbound WebSocket then forwards to
this Worker as a `NotifyEvent`. See `ingest.ts` for the exact message shape
(`Shelly.emitEvent()` nests the passed data under an event's `data` key).

## Architecture

- A single Cloudflare Worker (`src/worker.ts`) routes `/ws` and `/api/*` to one
  Durable Object (`HangtimeDO`, `src/durable-object.ts`); everything else is
  served from `public/index.html` via Workers Static Assets.
- The Durable Object holds all state in its embedded SQLite storage
  (`ctx.storage.sql`) and terminates the gateway's WebSocket using the
  Hibernation API, so it doesn't need to stay resident in memory just to keep
  an always-open, low-traffic socket alive.
- Auth is a single shared password → HMAC-derived cookie, same as the Ruby app.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in APP_PASSWORD, GATEWAY_TOKEN
npx wrangler dev
```

This serves the app at `http://localhost:8787`, with Durable Object SQLite
storage persisted locally under `.wrangler/state/`.

### Exercise the REST API

```sh
curl -c /tmp/cookies.txt -X POST localhost:8787/api/login \
  -H 'content-type: application/json' -d '{"password":"devpw"}'
curl -b /tmp/cookies.txt localhost:8787/api/state
curl -b /tmp/cookies.txt -X POST localhost:8787/api/reading \
  -H 'content-type: application/json' -d '{"location":"ute","temp":5.2}'
curl -b /tmp/cookies.txt -X POST localhost:8787/api/moose
```

### Simulate the gateway's WebSocket pushes

No real Shelly gateway needed — either run the bundled Node script:

```sh
GATEWAY_TOKEN=devtoken node test/simulate-gateway.mjs
```

or connect interactively with `wscat`:

```sh
wscat -c "ws://localhost:8787/ws?token=devtoken"
```

and paste JSON messages shaped like:

```json
{"method":"NotifyStatus","params":{"bthomesensor:200":{"value":4.5},"ts":1234567890}}
{"method":"NotifyEvent","params":{"events":[{"component":"bthomesensor:203","event":"single_push","ts":1234567890}]}}
```

After sending a few messages, `GET /api/state` should reflect the new
reading/moose, and `http://localhost:8787/` should show it in the UI on
manual refresh.

Note: local `wrangler dev` (Miniflare) won't fully replicate production
hibernation *timing*, but correctness is unaffected since all state lives in
`ctx.storage.sql` rather than in memory.

## Component mapping

`src/components.config.ts` maps Shelly BLU Gateway component ids (BTHome
sensor slots, e.g. `bthomesensor:200`) to `{location, kind}`. This is only
used by the legacy native-BLU-Gateway path in `ingest.ts` (a real BLU Gateway
Gen3 adopting BTHome sensors as its own components) — the current setup uses
`shelly/ble-hangtime-relay.js` instead, which maps sensor MAC addresses to
locations itself and doesn't need this file.

## Deploy

```sh
npx wrangler secret put APP_PASSWORD
npx wrangler secret put GATEWAY_TOKEN
npx wrangler deploy
```

No Cloudflare zone/domain is assumed here — bind a custom domain/route
separately once deployed.

Workers Builds is connected to this repo — pushes to `main` auto-deploy.
