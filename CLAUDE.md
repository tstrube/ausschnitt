# Ausschnitt

A self-hosted personal webcomic reader, installable as a PWA. It crawls a
webcomic's own site page by page (using CSS-selector "fingerprints" taught
once per comic), downloads each page's image, splits it automatically into
individual panels ("Ausschnitt" = cutout), and shows them on a
phone-friendly reader. Single-user or multi-user, chosen once in a
first-run setup wizard. One SQLite file plus an images folder.

Accounts subscribed to the same comic share its downloaded pages and
panels; each account has its own reading position, reading mode, ignored
pages and bookmarks.

Area details live next to the code and load when working there:
`src/CLAUDE.md` (crawling, page links, reader state, bookmarks,
notifications), `src/utils/CLAUDE.md` (panel splitting),
`public/CLAUDE.md` (scroll feed, theme, buttons, PWA), `views/CLAUDE.md`
(pages and settings layout).

## Rules

- **No real comics in the repo** (copyright): no comic images, names,
  URLs, page numbers or markup copied from a comic's site (its ids and
  class names) in code, comments, tests, docs, commit messages or pull
  request descriptions. Tests, the manual and `docs/screenshots.png` use
  synthetic images only. Issues may name and link a comic to report a
  broken site; whatever comes from one goes into the repo only as a
  synthetic reproduction. The comics being read live in the deployment's
  `data/`, outside the repo.
- **Comments and docs describe the current code only**: no history of
  what changed or was removed. A case that affects the user is handled in
  code, never left as a comment or a known-issue note.
- **No migrations**: the schema is one `CREATE TABLE IF NOT EXISTS` block
  in `src/db.ts`'s `initDb`, always the complete current schema. A schema
  change means editing that block *and* applying the same change once by
  hand to the live database (stop the container, run the change with the
  image's `node`/`better-sqlite3` against `data/ausschnitt.db`, start
  again), after trying it on a scratch copy. One-off data repairs work the
  same way and never stay in the app.
- **Paths** come from `src/paths.ts` (`DATA_DIR`, `IMAGES_DIR`, `DB_PATH`,
  `VIEWS_DIR`, `PUBLIC_DIR`, `BOOTSTRAP_CSS_DIR`) - never
  `__dirname`-relative paths, which differ between `src/` and `dist/`.
- **Dates** are displayed through `src/utils/formatDate.ts`'s
  `formatDateTime` (year-first, 24-hour), never `toLocaleString()`
  (server-locale dependent).
- **Access**: every comic-scoped route checks `db.isUserSubscribed` (404
  otherwise); client-supplied panel ids go through `routes/reader.ts`'s
  `panelInComic`.
- **`/proxy`** fetches arbitrary URLs by design (Select Elements'
  preview). Two SSRF layers: `proxySafety.ts`'s loopback/private-IP DNS
  check, and `proxy.ts`'s `fetchValidated` (`redirect: 'manual'`, the same
  check on every hop - a plain `fetch()` would follow a redirect to an
  internal address). Never weaken either layer without equivalent
  protection.

## Architecture

- **Runtime**: Node.js + TypeScript, compiled with `tsc` to `dist/` (`npm
  run build`; `npm run dev` watches) and run via `bin/www` (plain
  `http.createServer`, one process). `PORT`/`HOST` env vars (default
  `3000`/`0.0.0.0`). A single package: crawling and splitting stay
  in-process with synchronous storage.
- **Web framework**: Express 5, server-rendered Pug views (`views/*.pug`),
  no client-side framework - `public/js/*.js` are plain script tags.
  Bootstrap 5.3 (CSS only, no Bootstrap JS) comes from the `bootstrap` npm
  package, served at `/vendor/bootstrap/` - no CDN.
- **Storage**: `better-sqlite3` (WAL mode), `data/ausschnitt.db`. Shared
  comic cache in `comics`, `pages`, `panels`; accounts in `users`,
  `sessions`; per-account state in `comic_subscriptions`,
  `user_ignored_pages`, `bookmark_history`, `bookmarks`; device push
  subscriptions in `push_subscriptions`; key/value `settings`. Images live
  in `data/images/<comicId>/` - panels only: a split page's downloaded
  image is deleted after splitting (a page left whole is its own single
  panel); `pages` keeps its URL and `image_hash`.
- **HTTPS reverse proxy**: `BEHIND_HTTPS_PROXY` (`src/app.ts`), the one
  app env var, since it's a deployment-topology decision. When `true`:
  `trust proxy` and a `secure` session cookie. Only correct with a
  TLS-terminating reverse proxy in front that forwards
  `X-Forwarded-Proto`; without one, no login sticks.
- **Accounts & auth**: the `/setup` wizard (`src/middleware/auth.ts`'s
  `requireSetup`, gated on `db.hasAnyUser()`) runs when no `users` row
  exists. Two modes (`db.isMultiUser()`): single-user (one account, no
  username/password, auto-attached to every request by `resolveUser`, no
  login screen) or multi-user (every account has a username and
  password). Multi-user login is a profile picker (`GET /login`) then a
  password prompt for that account (`GET /login?user=<name>`). Sessions
  are `express-session` on `src/utils/sessionStore.ts` (`sessions`
  table), with a `SameSite=Lax` cookie (the CSRF protection - there are
  no CSRF tokens) and a new session id on every login (`loginAs`). Failed
  logins are limited per client address in memory (`routes/auth.ts`). Each account sees `/manual` on its first login
  (`users.has_seen_intro`). `src/routes/admin.ts` (admin-only) manages
  accounts; adding a second account turns a single-user instance
  multi-user, requires a password for the new account, and first requires
  the existing admin to set one (`POST /admin/account/password`) - the
  same request re-sets `req.session.userId` so the admin stays logged in.
  Deleting an account removes everything that's only its own.
- **Shared comics & subscriptions**: `comics`/`pages`/`panels` are shared
  cache, deduped by URL - `db.insertComic` (from `routes/add.ts`)
  subscribes a new account to an existing comic with that URL instead of
  re-crawling (and skips Select Elements, since selectors exist). "Delete"
  (`POST /delete/:id`, `db.removeUserFromComic`) unsubscribes and drops
  that account's state for the comic; the shared cache and comic row go
  once the last subscriber leaves - immediately in single-user mode.
  "Clear" (wipe downloads, keep comic and selectors) and "Clear all" are
  hidden and blocked (403) in multi-user mode, where the cache is shared.
- **Per-account reading state**: reading position, reading mode,
  start-at-first-panel, scroll bottom bar, notification mute and target
  live on `comic_subscriptions` (`db.getReaderComic`,
  `updateUserComicSettings`, `updateLastRead`, keyed by
  `(user_id, comic_id)`). NULL in `reading_mode`/`hide_scroll_nav`/
  `notification_target` means "use the default".
- **Bookmark rule**: Next/Back/page-first/ignore move the reading position
  (the "bookmark") only while the client is following it; First/Latest/
  resume-history restore/bookmark Go are previews; only "Save Resume
  Point" commits a jump.

## Request flow

1. `GET /` - the account's comics (`views/index.pug`); each links to
   `/reader/:id` if it has a `selector_image`, otherwise `/select/:id`.
2. `GET /add`, `POST /add` - add a comic by URL/title (`src/routes/add.ts`).
3. `GET /select/:id`, `POST /select/:id` - the comic's site in an iframe
   proxied through `GET /proxy` (around X-Frame-Options/CSP); the user
   clicks the image and nav elements in order
   (`public/js/selectorOverlay.js` builds the fingerprints), and the
   selectors are stored via `updateComicSelectors`.
4. `GET /reader/:id` - the current page/panel, or the first panel if
   nothing has been read; `views/reader-scroll.pug` when the effective
   reading mode is scroll (the default), extended via
   `GET /reader/:id/scroll-window` and saved via
   `POST /reader/:id/scroll-position`. `POST /reader/:id/nav/:direction`
   (`next`/`back`/`first`/`latest`/`page-first`/`resume`/`bookmark`/
   `ignore`) moves from the client's `panelId`, crawling and splitting a
   new page on demand, and saves the position under the bookmark rule.
5. `POST /delete/:id`, `POST /clear/:id` (home page), `POST /clear-all`
   (`/settings`) in `src/routes/index.ts` - see "Shared comics &
   subscriptions". Titles are set once at `/add`.

## Deployment

`docker compose up -d --build` (container `ausschnitt`, image built from
this `Dockerfile`; rebuilds and recreates the container, keeps the data).
The app listens on `3000` inside the container; the compose file
publishes it on `AUSSCHNITT_PORT` (default `3333`) and mounts
`AUSSCHNITT_DATA` (default `./data`) as `/app/data`, so a Portainer
repository stack - whose compose file isn't editable - is configured
through environment variables. A local `npm start` uses `data/`.

## Working in this repo

- Source of truth is `src/**/*.ts`; `dist/` is build output - never edit
  it, and rebuild before relying on it. `tsconfig.json` has `strict: true`.
- `npm test` (`tsc`, then `node --test` inside `dist`) runs Node's
  built-in test runner on `matchSelector` and `panelSplitter`, with
  synthetic pixel buffers and DOM fixtures only. Add cases there rather
  than starting another test setup. The `Dockerfile` build stage and CI
  (`.github/workflows/ci.yml`) run the tests; the image build strips
  `*.test.js`. Also verify UI and crawl changes by running the app for
  real - heuristics don't fail loudly. For realistic testing, run the app
  (or a throwaway container from a test-tagged image on a localhost-only
  port) against a scratch copy of `data/`.
- `better-sqlite3` ships prebuilt binaries for every platform and needs no
  install script, but npm infers a `node-gyp rebuild` from its
  `binding.gyp`. `package.json`'s `allowScripts` denies that (npm 12+);
  the `Dockerfile` and CI upgrade npm 11 to npm 12, which honors it - npm
  11 would try to compile it without a toolchain.
