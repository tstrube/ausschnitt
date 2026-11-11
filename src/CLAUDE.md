# Server: crawling, reader state, bookmarks, notifications

- **Comic crawling model**: each comic stores five `SelectorFingerprint`
  JSON blobs (`selector_image`, `selector_next`, `selector_back`,
  `selector_first`, `selector_latest`): `{ selector, tag, classes,
  parentTag, siblingTags, text }`. `utils/matchSelector.ts` tries the
  exact `selector` first, then scores every element of the recorded `tag`
  against the rest of the fingerprint, so navigation survives minor markup
  changes on the comic's site. `utils/fetch.ts` crawls forward/backward
  with these; nav hrefs and image `src`s are resolved against the page
  they were found on, and a nav link never leaves the comic's domain.
  Pages are parsed with jsdom without running their scripts. Every
  request to a comic site goes through `utils/http.ts`'s `crawlFetch`
  (the app's User-Agent, at most one request per host every 500ms);
  `/proxy` and `/add`'s scheme check send the User-Agent too.
- **The comic's homepage has no "next"**: a comic registered by its bare
  site URL (`comic.url`) can have its newest stored page anchored at that
  URL, which always shows whatever's current. `readerCache.ts`'s
  `stepPage` handles this: when the page's `original_url` is `comic.url`
  (`fetch.ts`'s `isComicHomeUrl`), it re-fetches the homepage and compares
  its image with the stored `image_hash` (`checkHomepageForNewPage`).
  Before storing a new homepage snapshot it walks back via the "back"
  selector and crawls any strips published in between. The homepage URL
  is the one URL that may be stored several times, once per strip it
  showed (different `image_hash`); `image_hash` is NULL where unknown.
- **Page links**: `pages.next_id`/`prev_id` are only set via
  `setPageLinkVerified`, for a relationship a real next/back crawl
  confirmed - never derived from `page_order`, which is only an insertion
  and sort index (a First/Latest jump can store a page numerically next to
  one that's thousands of strips away). A stored link is trusted outright.
  When a live crawl's Next/Back leads to a page that's already stored, the
  link is saved (`readerCache.ts`'s `linkToStoredPage`) unless the target
  is the homepage URL or already linked to a different page in that
  direction.
- **One row per page**: `fetchAndStorePage` shares one in-flight fetch per
  (comic, URL) and re-checks right before inserting, and splits the image
  first, so a page row, its panels and its link are written together with
  no `await` between - a page is never visible without its panels.
- **Ignored pages**: `user_ignored_pages`, per account, always reversible.
  Next/Back and the scroll feed skip them via `firstNonIgnoredPage`, which
  steps until a page that isn't ignored, with no length limit; it stops if
  it reaches a page twice (a link cycle from the site's own nav). Once
  every subscriber ignores a page, the Ignore that made it so deletes its
  panel files (`fetch.ts`'s `releaseIfIgnoredByAll`,
  `db.releasePageImages`): the page row, its links and its panel rows stay,
  with `image_path` NULL, so resume points, history, bookmarks and Undo
  still point at real panels. A page stored under the homepage URL is never
  released. Landing on a released page restores it first
  (`ReaderCache.setPageAndPanels` and `getPage` call `ensurePageImages`,
  which downloads the image again and splits it onto the same rows in
  order, `db.setPanelImages`). Read-ahead restores pages that reader
  hasn't ignored; skipping over a released page doesn't restore it.
- **Reading direction**: `comics.reading_direction` (`'ltr'`/`'rtl'`),
  chosen at `/add` by whoever adds the comic first, shared by every
  subscriber like the panels it orders. Only an admin changes it later
  (comic settings page; `POST /comics/:id/settings` ignores it from
  anyone else). Pages whose panels predate stored boxes are released on a
  change and re-split on the next landing.
- **Latest/First jumps** (`readerCache.ts`): `anchorForJump` resolves from
  the newest stored *permalink*, never a homepage row. When Latest points
  at the homepage, `newestViaHomepage` walks the stored next chain to the
  tip and checks the live homepage for anything newer. No Latest link
  means "already on the newest page". Routes that jump and then redirect
  to `/reader/:id` call `getComic()` (not `getComic(true)`) first, so the
  reader's first load after a restart doesn't bootstrap to the resume
  point.
- **In-memory reader state**: `ReaderCache` holds the open page/panel per
  (user, comic) so nav doesn't re-hit the DB/disk. Its cursor is shared by
  every device and tab of that account and `getWindowAround` moves it
  during crawls, so it never stands for what a client is showing: the
  client sends its panel (`POST /reader/:id/nav/:direction` takes
  `panelId`), and scroll-mode saving (`/scroll-position`) is a
  compare-and-set against the stored bookmark using the client's
  `fromPanelId`. `readAhead` keeps up to 5 pages downloaded beyond the
  furthest page a reader has asked for, in the background, one run per
  reader, pausing 3 minutes once it reaches the end of the comic.
  `ReaderCache.resetForComic(comicId)` invalidates every subscriber's
  instance after a shared-data change; `ReaderCache.reset(userId,
  comicId)` just one.
- **Resume history** (UI name; `bookmark_history` in code): checkpoints
  from "Save Resume Point", capped at `db.MAX_BOOKMARK_HISTORY` (10) per
  account and comic, oldest dropped first. Restoring one
  (`POST /reader/:id/bookmarks/:id/restore`) is a preview like
  First/Latest - it never touches the live bookmark or adds an entry.
  "Save Resume Point" first snapshots the position it replaces
  (`snapshotLiveBookmarkIfReplacing`, skipped if it's already the newest
  entry); `source` is `'user'` for the click, `'auto'` for the snapshot.
  A separate feature from named bookmarks, with its own icon (🕘) and name.
- **Named bookmarks**: `bookmarks` table - permanent, user-named spots.
  Saved from the reader's 🔖 panel (`POST /reader/:id/bookmarks`, name
  defaults to `"{comic title} — {date}"`), managed across all comics on
  `GET /bookmarks` (paginated, rename/delete). "Go" is always a preview:
  `POST /reader/:id/bookmarks/:id/go` inside an open reader,
  `GET /reader/:id/jump/:pageId/:panelId` from the manager page.
- **Disk-usage cap & LRU eviction**: opt-in (`/admin/cache/max-usage`,
  `max_disk_usage_bytes`, blank/0 = unlimited). After anything that may
  have downloaded a page, `ReaderCache.evictOverCapIfNeeded` clears the
  least recently *read* comic (`db.getLeastRecentlyAccessedComic`, never
  read first; `db.touchComicCacheAccess` on every panel view) until under
  the cap, never the same comic twice in one pass. `POST
  /admin/cache/clear-now` clears every comic regardless of subscribers.
- **New-page notifications**: Web Push (`web-push`, VAPID keys generated
  once into `settings`). `newPageNotifier.ts` ticks every 5 minutes; a
  comic is checked at most every `new_page_check_hours` (`/settings`,
  default 6, 0 = never), and only if a subscriber has a
  `push_subscriptions` row and hasn't muted it
  (`comic_subscriptions.notify_new_pages`). A check only looks: it
  resolves "Latest" from the newest stored permalink and stores it as
  `comics.latest_signature` (the URL, or `home:<image src>` for the
  homepage); the first check is a baseline, a change notifies unless that
  URL is already stored. Tapping opens `GET
  /reader/:id/open/notification`, resolved at tap time to the comic's
  `notification_target`, else the account's
  (`db.getEffectiveNotificationTarget`) - the resume point, or the newest
  page as a preview. No notification action buttons (iOS can't show
  them). Devices opt in on `/settings` (`public/js/notifications.js`,
  `routes/push.ts`); subscriptions answered 404/410 are pruned. The VAPID
  subject is the origin the device subscribed from. Testing: Playwright's
  Chromium can't subscribe (no push service) - insert a mock https
  endpoint into `push_subscriptions`, and test display via CDP
  `ServiceWorker.deliverPushMessage`.
