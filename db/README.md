# Levera Postgres store

Durable home for protocol/research data that used to live in browser `localStorage`.

## Create the database

```bash
createdb levera
```

That is the whole setup. The schema **applies itself**: `ensureSchema()` runs before the first query
in every process, so a fresh clone, a dropped database, or a schema change that landed in git but
not in the local Postgres is a non-event rather than an opaque 500 mid-session — by which point
whatever the session was measuring is already lost.

```bash
npm run migrate   # apply the schema by hand
npm run wipe      # clean slate: every session table, identity counters reset
npm run counts    # row counts per table
npm run smoke     # schema + store round trip + wipe
```

Every statement in `schema.sql` is idempotent. Keep it that way.

Default URL (no password, local socket/TCP):

```
postgresql://mac@127.0.0.1:5432/levera
```

Override with `DATABASE_URL` in `frontend/.env.local` and `ui/.env.local`.

## What lives here

| Table | Replaces |
|---|---|
| `hfyc_nav` | `hfyc-nav:<factory>` |
| `price_points` | `launchpad-price-history`, `launchpad-ui:price-history:*` |
| `ledger_totals` + `trades` | `launchpad-ui:ledger:*`, `launchpad-frontend:ledger:*` |
| `rebalances` | `launchpad-ui:rebalances:*` |
| `x_profiles` | `data/x-profiles.json` + `launchpad-frontend:x-profile:*` |
| `collateral_samples` | (new) one row per listed collateral per sample |

Still in the browser: explore grid/table, filters, sidebar collapse, favorites, bot private keys.

## Wiping

A console **Deploy wipe** truncates **every** session table and clears the research CSVs,
automatically, before the new contracts go up.

It is deliberately not scoped to the outgoing factory. That address is read from a local file the
wipe itself deletes, so scoping left earlier sessions' rows behind after a crash, on a fresh clone,
or on a second redeploy in a row — and two incompatible books in one series is worse than no series:
it silently changes what every aggregate means, and nothing in the data says which rows came from
which deployment.

`x_profiles` survives. It maps a wallet to the X account that claimed it, which is not session
state, and wiping it would make people reconnect their identity because somebody restarted a fork.
