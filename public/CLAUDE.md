# Frontend: scroll feed, theme, buttons, PWA

- **Scroll feed stability** (`js/readerScroll.js`): what's on screen never
  moves unless the reader scrolls it. Every panel's size is known up front
  (`panelSize` in `src/routes/reader.ts`) and pinned as inline `width` +
  `aspect-ratio` (`sizePanel`). Panels are never removed while scrolling;
  ones more than 5000px away swap to a blank 1x1 image and back
  (`unloadObserver`). `#topSpacer` is a blank runway (`RUNWAY_PX`,
  30000px) while earlier panels may exist: earlier panels are inserted
  into it and take exactly their height from it, and only as many as fit
  (`fitInRunway`, computed from the known sizes); the rest load after the
  next top-up. `scrollTop` is never written during a drag or momentum
  flick (iOS overrides such writes after the content has moved): the
  runway is topped up, or removed once the comic's start is loaded, only
  when idle - no touch and no scroll event for 1s. The feed has
  `overflow-anchor: none`. A rebuild (any jump) bumps `feedGeneration`,
  and a load requested before it is discarded. Loads skip panels already
  in the feed. Loading is checked directly (`checkEdges`): after every
  load and on every scroll frame, the side within `LOAD_AHEAD_PX`
  (3000px) of a loaded edge loads more, below first. The resume banner
  floats over the top of the feed (`.reader-feed-area`), so showing or
  hiding it never moves panels. Ignore targets the page with the most
  total area on screen (`pageMostOnScreen`) and removes its panels in
  place (`removePageInPlace`) - the next page slides into their spot; the
  view moves only if the ignored page began above the screen.
- **Scroll position across reloads**: on leaving, the scroll reader sends
  its position with `sendBeacon`. A reload requests the new page before
  the old one's `pagehide`, so the old page also notes the position in
  `sessionStorage` (`ausschnitt:pendingPosition:<comicId>`) and the new
  page re-reports and restores it (`restorePendingPosition`). The note is
  cleared when the page becomes visible again, never in the hide handler
  (visibilitychange and pagehide both fire on reload).
- **Light/dark theme**: `#themeSelect` (System/Light/Dark) on `/settings`,
  `js/theme.js` and Bootstrap 5.3's `data-bs-theme` - per device
  (`localStorage` key `theme`). An inline script at the top of
  `views/layout.pug`'s `<head>` applies it before any paint; "System"
  follows `prefers-color-scheme` live. Reader and Select Elements content
  areas follow the theme (dark mode reader background is pure black);
  header and control bars are always dark.
- **Consistent header chrome**: every header/control bar (navbar, reader
  top bar and bottom controls, Select Elements bars) uses `#212529`
  (Bootstrap's `bg-dark`/`theme-color`) and the same icon for the same
  action at regular button size: 🏠 home, 🔖 bookmarks, 🕘 resume history
  (reader), 🚫 ignore (reader), ⚙ settings (the comic's in the readers,
  global elsewhere), 👥 admin, 🚪 log out, ❓ manual - never a text label
  in one place and an icon elsewhere. Header icon buttons carry
  `.btn-icon` (`css/buttons.css`, one fixed width; only the reader's top
  bar may shrink them on narrow screens). Select Elements' step and hint
  text colors (`css/select.css`) are tuned for its dark bar.
- **Buttons** (`css/buttons.css`, global): theme-scoped CSS-variable
  overrides fix the low-contrast Bootstrap variants
  (`.btn-outline-warning` in light mode, `.btn-outline-secondary` in dark
  mode) - use the same pattern for any other contrast fix. Touch-only
  devices (`@media (hover: none)`) show hover as the normal state. Every
  `.btn` and header/control bar has `touch-action: manipulation`: no
  double-tap zoom (Ignore then its "OK?" confirm), pinch-zoom still works
  (iOS Safari only honors `auto`/`manipulation`).
- **Installable app (PWA)**: `manifest.webmanifest`, `sw.js`,
  `offline.html`, registered by `js/pwa.js`, linked from
  `views/layout.pug` (plus Apple's `apple-touch-icon`/
  `apple-mobile-web-app-*` tags). The service worker is network-only: it
  only replaces a failed page navigation with `offline.html` and never
  caches pages (reading positions would go stale). Bump its `CACHE` name
  when `offline.html` changes. Service workers need HTTPS or localhost.
  Icons in `icons/` are PNGs rendered with `sharp` from `favicon.svg`,
  `icons/icon-maskable.svg` and `icons/icon-full.svg` (for
  `apple-touch-icon.png`); re-render them if the favicon changes. Static
  files are served before auth (the manifest is fetched without cookies).
