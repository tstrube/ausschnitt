# Panel splitting (`panelSplitter.ts`)

Runs on each new page's image right after download. The module's doc
comment describes the algorithm and each function documents its step;
these are the invariants a change must keep:

- **The safe direction is no split.** Anything that isn't a confident
  grid stays one whole panel - an unsplit page is a minor inconvenience, a
  false split a broken one.
- **Background color is measured per page** from its corners
  (`estimateMarginColor`) - never a fixed color.
- **Dividers are gaps in exactly that color**, at least
  `MIN_MEANINGFUL_GUTTER_PX` (4px) thick (`keepThickDividers`). A drawn
  frame line in another color is never a divider. Thinner lines may still
  separate a panel from a caption right above or below it
  (`trimToPanelSlices`, which never shrinks a panel below half its area).
- **Thin content never joins panels**: `labelPanels` finds panels on the
  thick parts of the content only (a 1px line along the image edge would
  otherwise merge them all); a panel's own thin outline comes back in
  `tightenBox`.
- **Boxes fit their panel exactly**: detection runs on a 2px grid;
  `tightenBox` grows each edge by up to 3px into content at full
  resolution, then `shaveGutterEdges` removes edge lines in the gutter
  color or a gutter/border antialias blend - no light line may show
  between panels in the dark reader.
- **Titles and footers are cut by shape only** (`trimTitleBand`, outer
  panels only): text on a bar or on the page background, glued too close
  to the panel for a gutter, recognized by `isTextRow` (thin strokes, no
  contrasting run wider than 20px) - never by color or position alone.
- **Panel files are never rewritten** under an existing name: they're
  served with a 30-day `immutable` cache (`app.ts`).
- **Tests**: `detectPanelBoxes` (raw pixels in, boxes out) is exported for
  `panelSplitter.test.ts`; `splitIntoPanels` is the file-in/files-out
  entry point. Every heuristic change gets a synthetic test case.
