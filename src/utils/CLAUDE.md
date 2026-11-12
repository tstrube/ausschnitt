# Panel splitting (`panelSplitter.ts`)

Runs on each new page's image right after download. The module's doc
comment describes the algorithm and each function documents its step;
these are the invariants a change must keep:

- **Gutter-first.** A page is cut along its gutters, and its panels are
  exactly the cells between them - nothing is fitted to the artwork (a
  cell only changes by the bubble and edge-line rules below). A gutter is
  a band of 2+ lines straight across the area being cut, every line clean
  in one gutter color. The page is cut into rows, each row into columns,
  and so on, while every part is panel-sized; at the page level a too-small part at the top or bottom is the title or
  footer and is dropped. No special case for a single page: a fix stays
  inside this model or leaves the page whole.
- **The safe direction is no split.** Anything that isn't a confident
  split stays one whole panel - an unsplit page is a minor inconvenience,
  a false split a broken one. A row gutter cut in one column but blocked in
  its neighbor leaves the whole page unsplit (the panels couldn't be read
  in order). Blocked means a gap: the strip is clearly lighter than the
  column's lines right around it, not just a frameless panel's own
  background.
- **Gutter colors are measured per page**: the margin color from the
  page's corners (`estimateMarginColor`); only where that doesn't divide
  the page, a second inner color (a frame around gutters of another
  color). Never a fixed color.
- **Text isn't a gutter**: a gap between two parts that are both nearly
  all gutter color (lines of text, a form on a white panel) isn't cut
  unless drawn frames line it; the reading-order check also runs on the
  cut without that merge. Nor is a part holding only speech bubbles a
  panel (`onlyBubbles`).
- **Frameless panels** whose background is the gutter color
  (`alignGutters`): a gap with no panel edge on either side (`hasEdge`: a
  frame or straight artwork edge, looked for past antialiasing) is never
  cut, whatever its width - joined before the reading-order check, so
  such gaps never count as cuts there. A band with an edge on one side is
  a gutter of the page's usual width (the median of the gutters left after
  joining) beside that edge; the rest is the frameless panel's
  background.
- **Speech bubbles** (`findBubbles`: a closed light area holding many
  small enclosed letters) may cross a gutter: a band clean apart from a
  bubble still counts when at most half of it lies under bubbles
  (`bubbleShare`) and drawn frame lines run along both sides
  (`isFramed`). The cell holding most of the bubble grows to take it in
  whole, and the rest of the added strip is painted in the page's measured
  gutter color, the outline redrawn toward it (`withBubbles`,
  `PanelCrop.paint`); painted panels are saved as PNG.
- **No light lines in the dark reader**: every panel side along a gutter
  loses 1px (`insetFromGutters`), plus up to 2 antialiased lines blended
  between gutter and frame (`trimBlendLines`, a line lighter than the next
  along 75% of its length). Where the inner gutters'
  color continues as a frame around the panel area, panels on that edge
  lose it (`trimOuterFrame`).
- **Reading order** (`sortReadingOrder`): rows top to bottom, columns in
  the comic's reading direction (`ltr`/`rtl`), each column top to bottom.
  Each panel's box on its page is stored (`panels.box_*`), so a direction
  change renumbers stored panels without their images (`fetch.ts`'s
  `applyReadingDirection`).
- **Panel files are never rewritten** under an existing name: they're
  served with a 30-day `immutable` cache (`app.ts`).
- **Tests**: `detectPanelBoxes` (raw pixels in, crops out) is exported for
  `panelSplitter.test.ts`; `splitIntoPanels` is the file-in/files-out
  entry point. Every heuristic change gets a synthetic test case and a
  by-eye check against real pages.
