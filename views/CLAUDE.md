# Pages

Styling rules (header chrome, icons, buttons, theme) are in
`public/CLAUDE.md`.

- **Reader UI**: `reader.pug` (panel by panel) and `reader-scroll.pug`
  (endless scroll) replace the navbar via `block body` with a full-height
  layout (`public/css/reader.css`): the icon row, the panels, and a
  compact control bar - no comic title. `public/js/reader.js` handles
  buttons and swipe left/right (no keyboard shortcuts), with a spinner
  while a nav request runs.
- **Account buttons**: Username/Admin/Log out are
  `includes/account-buttons.pug`, multi-user mode only, on every page
  except the two readers.
- **Global settings page**: `GET /settings` (`settings.pug`), the navbar's
  ⚙ on every page except the readers (whose ⚙ is that comic's settings).
  Theme, default reading mode and scroll bottom bar, new-page
  notifications (device toggle, check interval, notification target),
  disk usage and free space, and Clear all (single-user only). Each
  `POST /settings/*` (and `/clear-all`) redirects back to `/settings`. The
  comic list holds only comics.
- **Settings layout**: phone-style rows (`public/css/settings.css`) on
  both settings pages - grouped `.list-group`s under small uppercase
  headings, `.settings-row` with the label left and control right, every
  dropdown one width (`min(13rem, 50%)`), checkboxes as right-aligned
  switches whose whole row is the `<label>`, saving on change (no Save
  button). Dropdown options stay short enough for that width; a per-comic
  "Default" option shows the inherited value as a hint under the label.
- **Comic settings page**: `comic-settings.pug` (`GET/POST
  /comics/:id/settings`), three tabs as plain links
  (`?tab=settings|history|ignored`, short labels with count badges, one
  row that never wraps). General: the per-comic settings (title is set
  once at `/add`). History: resume checkpoints, paginated
  (`?resumeHistoryPage=`, 10 per page, `db.getBookmarkHistoryPage`),
  individually deletable. Ignored: every ignored page
  (`db.getIgnoredPages`), sorted by `?sort=url-asc|url-desc|date-asc|
  date-desc` (default newest first; URLs compare numerically via
  `Intl.Collator`), each with Undo (`POST /undo-ignore/:id`, keeps the
  sort).
- **Manual**: `manual.pug`, shown on each account's first login; its
  examples use the synthetic images in `public/img/manual/`.
