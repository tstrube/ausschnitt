import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

/**
 * Best-effort automatic panel splitting for a downloaded comic page image.
 *
 * Algorithm (border-seeded gutter flood-fill + connected components):
 *
 * 1. Grow the page's real divider network from its own outer edge (see
 *    computeDividerNetwork):
 *    - Seed it with the outer margin - grown inward from the image's
 *      actual edge via plain same-color adjacency, however wide (anything
 *      contiguously connected to the real edge is the page's margin).
 *    - Extend it through *bars* - long, thin, flat-colored runs in the
 *      page's own margin color (see estimateMarginColor), and only that
 *      color: a plain gutter is a divider, a drawn line in another color
 *      isn't. A bar joins only if it touches the margin or another
 *      connected bar - never through some blob-shaped region of matching
 *      color, such as a chart cell's interior or a panel's own background
 *      that happens to touch it.
 *    Everything not reached this way is CONTENT.
 * 2. Label 8-connected components of the CONTENT cells, ignoring content
 *    too thin to be art mass (labelPanels). Each component's bounding box
 *    is a candidate panel - real 2D adjacency, so a stick figure's feet or
 *    two widely spaced elements within one panel don't break it apart, and
 *    a hairline doesn't join two panels.
 * 3. Discard components smaller than MIN_PANEL_FRACTION (stray marks), then
 *    merge pairs of boxes that overlap (irregular art can have overlapping
 *    bounding boxes) or are row/column neighbors with a gap below
 *    MIN_MEANINGFUL_GUTTER_PX - a sampling-resolution floor, not a style
 *    calibration. No size- or distance-ratio heuristics.
 * 4. Confidence gate: candidate boxes must together cover a high fraction
 *    of the area they span, and there must be between 2 and MAX_CANDIDATES
 *    of them - otherwise fall back to the whole page (charts, infographics,
 *    anything that isn't a confident grid).
 * 5. Fit each box exactly to its panel (tightenBox), cut title bars fused
 *    to the outer panels (trimTitleBand), and sort into reading order
 *    (top-to-bottom, then left-to-right within a row).
 *
 * The whole page as one panel is always a valid result and the fallback
 * direction: an unsplit page is a minor inconvenience, a false split a
 * broken one.
 */

// Euclidean RGB distance two neighboring sampled cells may differ by and
// still count as "the same color" when tracing a line run. Tight: it only
// absorbs rounding/dithering noise - a warm cream wall (255,249,240) is
// ~16 from a white margin and must stay a different color, and a real
// gutter has essentially no internal variance.
const COLOR_EXACT_EPSILON = 6;
const MIN_PANEL_FRACTION = 0.08;
const SAMPLE_STRIDE = 2;

// A sampled cell counts as part of a candidate divider *line* if, in one
// direction, it belongs to a same-color run at least this fraction of the
// page's corresponding dimension long, while in the perpendicular
// direction that run is no thicker than this fraction of the page's
// dimension. No color is assumed or hardcoded - whatever single flat color
// actually forms a long thin run is trusted, the same way a human eye
// picks a divider line out from its shape rather than its specific color.
const LINE_MIN_LENGTH_FRACTION = 0.3;
const LINE_MAX_THICKNESS_FRACTION = 0.1;

// Fraction of the shorter side that two boxes must overlap along to be
// considered row- or column-neighbors (as opposed to diagonally placed).
const ALIGNMENT_OVERLAP_FRACTION = 0.3;

// A gap narrower than this is never trusted as a deliberate divider on its
// own - at SAMPLE_STRIDE=2, anything under ~2 sample columns/rows wide is
// indistinguishable from a single stray compression/anti-aliasing artifact
// reaching the border by chance, which real (non-synthetic, JPEG-ish)
// comic scans do produce. This is a sampling-resolution floor, not a
// comic-style calibration - it scales with SAMPLE_STRIDE, not with any
// particular page's proportions.
const MIN_MEANINGFUL_GUTTER_PX = SAMPLE_STRIDE * 2;

const MIN_COVERAGE_FRACTION = 0.7;

// Detection runs on a SAMPLE_STRIDE grid, so a box's edges can be off by up
// to a stride: a pixel of the panel's own border cut off on one side, a
// pixel of gutter left in on the other. A leftover gutter line is invisible
// against a light reader background but shows as a white line between
// panels in dark mode. tightenBox fixes both at full resolution: grow an
// edge while the line just outside is mostly content - also bringing back
// a panel outline too thin for labelPanels' thick parts - by less than
// MIN_MEANINGFUL_GUTTER_PX, so never across a gutter into a neighboring
// panel; then shave edge lines that are gutter (shaveGutterEdges).
// Epsilon allows for JPEG noise in a white gutter.
const GUTTER_TRIM_EPSILON = 36;
const GUTTER_LINE_FRACTION = 0.95;
// An antialiased edge line - a blend of the gutter and the panel's border,
// e.g. gray between white gutter and a black frame - counts as gutter too
// when it's clearly closer to the gutter than the line just inside it:
// it's only a partial pixel of border, and in dark mode it shows as a
// light line just like gutter does.
const BLEND_MIN_STEP = 40;
const MAX_EDGE_GROW_PX = MIN_MEANINGFUL_GUTTER_PX - 1;
const MAX_EDGE_TRIM_PX = SAMPLE_STRIDE * 2;
const MAX_CANDIDATES = 12;

export interface Box {
    left: number;
    top: number;
    width: number;
    height: number;
}

export interface RGB {
    r: number;
    g: number;
    b: number;
}

// Reads the color of one pixel regardless of the source image's native
// channel count (1 = already greyscale, 2 = greyscale+alpha, 3 = RGB, 4 =
// RGBA) - so a comic delivered as a paletted/greyscale PNG is handled the
// same way as a full-color one, without needing to force a colorspace
// conversion up front.
function readPixel(data: Buffer, idx: number, channels: number): RGB {
    if (channels === 1 || channels === 2) {
        const v = data[idx];
        return { r: v, g: v, b: v };
    }
    return { r: data[idx], g: data[idx + 1], b: data[idx + 2] };
}

function colorDistance(a: RGB, b: RGB): number {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
}

// One RGB sample per grid cell (gw x gh), read once and reused by both the
// background-match test and the line-run detector below.
function buildColorGrid(data: Buffer, width: number, height: number, channels: number, gw: number, gh: number): RGB[] {
    const colors: RGB[] = new Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
        const y = Math.min(gy * SAMPLE_STRIDE, height - 1);
        for (let gx = 0; gx < gw; gx++) {
            const x = Math.min(gx * SAMPLE_STRIDE, width - 1);
            colors[gy * gw + gx] = readPixel(data, (y * width + x) * channels, channels);
        }
    }
    return colors;
}

// For every grid cell, the length (in cells) of the maximal run of
// same-color cells it belongs to, along each axis independently - i.e.
// "if I only looked at this row, how long a same-color streak is this
// cell part of", and likewise for its column. A single left-to-right (then
// right-to-left) pass per row/column, O(gw*gh) total.
function computeRuns(colors: RGB[], gw: number, gh: number, horizontal: boolean): Int32Array {
    const sameColor = (i: number, j: number) => colorDistance(colors[i], colors[j]) <= COLOR_EXACT_EPSILON;
    const run = new Int32Array(gw * gh);
    const outerLen = horizontal ? gh : gw;
    const innerLen = horizontal ? gw : gh;
    const indexOf = (outer: number, inner: number) => horizontal ? outer * gw + inner : inner * gw + outer;

    for (let outer = 0; outer < outerLen; outer++) {
        let runStart = 0;
        for (let inner = 1; inner <= innerLen; inner++) {
            if (inner === innerLen || !sameColor(indexOf(outer, inner), indexOf(outer, runStart))) {
                const runLen = inner - runStart;
                for (let k = runStart; k < inner; k++) run[indexOf(outer, k)] = runLen;
                runStart = inner;
            }
        }
    }
    return run;
}

// The length of the longest run of *consecutively thin* cells a given cell
// belongs to, within its own same-color segment - "thin" meaning that
// cell's own perpendicular run (vRun for a horizontal candidate, hRun for a
// vertical one) is within maxThickness. A sub-run, not a property of the
// whole segment, built from each cell's own perpendicular run:
// - A single thin cell isn't trusted on its own: at the edge of a notch cut
//   into a content blob, one column's run is short although the row is
//   part of a big blob everywhere else.
// - Thickness isn't aggregated over the whole same-color segment: a page's
//   wide outer margin and a narrow internal gutter are usually one
//   connected region, and the margin's width must not disqualify the
//   gutter.
// A long enough sub-run of individually thin cells is thin exactly where a
// real divider is, without being thrown off by a short notch or by a wider
// part of the same region elsewhere.
function computeThinSubrunLength(colors: RGB[], gw: number, gh: number, horizontal: boolean, perpendicularRun: Int32Array, maxThickness: number): Int32Array {
    const sameColor = (i: number, j: number) => colorDistance(colors[i], colors[j]) <= COLOR_EXACT_EPSILON;
    const result = new Int32Array(gw * gh);
    const outerLen = horizontal ? gh : gw;
    const innerLen = horizontal ? gw : gh;
    const indexOf = (outer: number, inner: number) => horizontal ? outer * gw + inner : inner * gw + outer;

    for (let outer = 0; outer < outerLen; outer++) {
        let segStart = 0;
        for (let segEnd = 1; segEnd <= innerLen; segEnd++) {
            if (segEnd === innerLen || !sameColor(indexOf(outer, segEnd), indexOf(outer, segStart))) {
                let thinStart = segStart;
                for (let k = segStart; k <= segEnd; k++) {
                    const isThin = k < segEnd && perpendicularRun[indexOf(outer, k)] <= maxThickness;
                    if (!isThin) {
                        const thinLen = k - thinStart;
                        for (let m = thinStart; m < k; m++) result[indexOf(outer, m)] = thinLen;
                        thinStart = k + 1;
                    }
                }
                segStart = segEnd;
            }
        }
    }
    return result;
}

// Grows the trusted margin/gutter region inward from the image's own outer
// edge, seeded only from border cells in the page's established margin
// color (see estimateMarginColor) and extended through adjacent cells of
// that same fixed color - no thin/long shape requirement, since a page's
// outer margin can legitimately be wide. Anchored to one fixed color rather
// than chaining from whatever color each border cell has: a panel's own
// background can touch the image edge somewhere, and chaining from there
// would sweep that panel's interior into the margin.
function floodFillSameColorFromEdge(colors: RGB[], gw: number, gh: number, marginColor: RGB): Uint8Array {
    const matchesMargin = (i: number) => colorDistance(colors[i], marginColor) <= COLOR_EXACT_EPSILON;
    const visited = new Uint8Array(gw * gh);
    const queue = new Int32Array(gw * gh);
    let qHead = 0;
    let qTail = 0;

    const tryPush = (gx: number, gy: number) => {
        const idx = gy * gw + gx;
        if (!visited[idx] && matchesMargin(idx)) {
            visited[idx] = 1;
            queue[qTail++] = idx;
        }
    };

    for (let gx = 0; gx < gw; gx++) {
        tryPush(gx, 0);
        tryPush(gx, gh - 1);
    }
    for (let gy = 0; gy < gh; gy++) {
        tryPush(0, gy);
        tryPush(gw - 1, gy);
    }

    while (qHead < qTail) {
        const idx = queue[qHead++];
        const gx = idx % gw;
        const gy = (idx / gw) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = gx + dx;
                const ny = gy + dy;
                if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
                tryPush(nx, ny);
            }
        }
    }
    return visited;
}

// The mode color among the image's four corners. Not an area vote over
// everything the flood reached - a panel background that touches the
// image edge and recurs across several panels can outnumber the real
// margin - and not the whole border either: panels often run flush to the
// left/right edges for the full height, so their color outnumbers a thin
// top/bottom margin there. A panel is very unlikely to occupy all four
// corners at once.
function estimateMarginColor(colors: RGB[], gw: number, gh: number): RGB {
    const cornerSize = Math.max(1, Math.min(6, Math.floor(gw / 6), Math.floor(gh / 6)));
    const histR = new Array(256).fill(0);
    const histG = new Array(256).fill(0);
    const histB = new Array(256).fill(0);
    const add = (idx: number) => {
        histR[colors[idx].r]++;
        histG[colors[idx].g]++;
        histB[colors[idx].b]++;
    };
    const addCorner = (left: number, top: number) => {
        for (let dy = 0; dy < cornerSize; dy++) {
            for (let dx = 0; dx < cornerSize; dx++) {
                add((top + dy) * gw + (left + dx));
            }
        }
    };
    addCorner(0, 0);
    addCorner(gw - cornerSize, 0);
    addCorner(0, gh - cornerSize);
    addCorner(gw - cornerSize, gh - cornerSize);
    const mode = (hist: number[]): number => {
        let best = 0;
        let bestCount = -1;
        for (let v = 0; v < 256; v++) {
            if (hist[v] > bestCount) {
                bestCount = hist[v];
                best = v;
            }
        }
        return best;
    };
    return { r: mode(histR), g: mode(histG), b: mode(histB) };
}

// Shape-only evidence (independent of color) for where a candidate divider
// *line* could be - a long, thin run, regardless of what color it turns out
// to be. Kept separate from the margin-color match itself (see
// computeDividerNetwork) so the two concerns - "is this shaped like a
// divider" and "is this the page's actual divider color" - stay independent
// tests.
interface LineShapeEvidence {
    hThinRun: Int32Array;
    vThinRun: Int32Array;
    minLenH: number;
    minLenV: number;
}

function computeLineShapeEvidence(colors: RGB[], gw: number, gh: number): LineShapeEvidence {
    const hRun = computeRuns(colors, gw, gh, true);
    const vRun = computeRuns(colors, gw, gh, false);
    const maxThicknessH = LINE_MAX_THICKNESS_FRACTION * gh;
    const maxThicknessV = LINE_MAX_THICKNESS_FRACTION * gw;
    return {
        hThinRun: computeThinSubrunLength(colors, gw, gh, true, vRun, maxThicknessH),
        vThinRun: computeThinSubrunLength(colors, gw, gh, false, hRun, maxThicknessV),
        minLenH: LINE_MIN_LENGTH_FRACTION * gw,
        minLenV: LINE_MIN_LENGTH_FRACTION * gh
    };
}

// The page's real divider network: the outer margin (grown from the image
// edge by same-color adjacency anchored to the page's established margin
// color, see floodFillSameColorFromEdge/estimateMarginColor) plus every
// *bar* (a long, thin, flat-colored run - see computeThinSubrunLength) that
// connects to the margin or to another connected bar, AND whose own color
// matches that margin color. A divider is the page's background color (a
// plain gutter), never a contrasting drawn line: contrasting bar-shaped
// runs occur in artwork (a wall's grout lines), and a scanned ink frame
// varies pixel to pixel too much to be one color. A page whose panels are
// separated only by drawn frame lines stays one whole panel.
//
// Two touching regions don't join just because they're the same class -
// only a bar extends the network past the margin, and only into more bar,
// never into a blob-shaped region of matching color. That keeps a chart
// cell's interior (a same-colored blob enclosed by its own border) out of
// the network. A bar not connected to the margin or another connected bar
// is an incidental shape in the art, not a divider.
function computeDividerNetwork(colors: RGB[], gw: number, gh: number, marginColor: RGB, shape: LineShapeEvidence): Uint8Array {
    const margin = floodFillSameColorFromEdge(colors, gw, gh, marginColor);

    const isBar = new Uint8Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) {
        const shapeQualifies = shape.hThinRun[i] >= shape.minLenH || shape.vThinRun[i] >= shape.minLenV;
        if (!shapeQualifies) continue;
        isBar[i] = colorDistance(colors[i], marginColor) <= COLOR_EXACT_EPSILON ? 1 : 0;
    }

    const reached = new Uint8Array(gw * gh);
    const queue = new Int32Array(gw * gh);
    let qHead = 0;
    let qTail = 0;
    for (let i = 0; i < gw * gh; i++) {
        if (margin[i]) {
            reached[i] = 1;
            queue[qTail++] = i;
        }
    }

    while (qHead < qTail) {
        const idx = queue[qHead++];
        const gx = idx % gw;
        const gy = (idx / gw) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = gx + dx;
                const ny = gy + dy;
                if (nx < 0 || nx >= gw || ny < 0 || ny >= gh) continue;
                const nIdx = ny * gw + nx;
                if (!reached[nIdx] && isBar[nIdx]) {
                    reached[nIdx] = 1;
                    queue[qTail++] = nIdx;
                }
            }
        }
    }
    return reached;
}

// The divider network minus every part thinner than
// MIN_MEANINGFUL_GUTTER_PX (a morphological opening: a cell survives only
// if some fully-reached k x k block of cells contains it). The margin
// flood follows plain same-color adjacency with no shape limit, so a 1px
// outline in the margin's color running from the gutter above a panel to
// the gutter below it (a door frame's edge on a black-gutter page) would
// otherwise cut the panel in two - and mergeBoxes' gap floor can't catch
// it, because the sliver between two such lines is dropped as too small,
// leaving a gap wide enough to pass. Real gutters are never that thin, so
// panels are found on this thick-only network (see trimToPanelSlices for
// what thin lines may still do). Out-of-bounds cells count as reached, so
// a thin outer margin along the image edge still survives.
function keepThickDividers(reached: Uint8Array, gw: number, gh: number): Uint8Array {
    return thickParts(reached, gw, gh, 1);
}

// The cells of `mask` that lie in some fully-set k x k block (k cells =
// MIN_MEANINGFUL_GUTTER_PX) - a morphological opening. `outside` is the
// value cells beyond the image edge count as.
function thickParts(mask: Uint8Array, gw: number, gh: number, outside: 0 | 1): Uint8Array {
    const k = Math.max(1, Math.round(MIN_MEANINGFUL_GUTTER_PX / SAMPLE_STRIDE));
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= gw || y >= gh) ? outside : mask[y * gw + x];
    const kept = new Uint8Array(gw * gh);
    for (let by = -(k - 1); by < gh; by++) {
        for (let bx = -(k - 1); bx < gw; bx++) {
            let full = true;
            for (let dy = 0; dy < k && full; dy++) {
                for (let dx = 0; dx < k; dx++) {
                    if (!at(bx + dx, by + dy)) {
                        full = false;
                        break;
                    }
                }
            }
            if (!full) continue;
            for (let dy = 0; dy < k; dy++) {
                for (let dx = 0; dx < k; dx++) {
                    const x = bx + dx;
                    const y = by + dy;
                    if (x >= 0 && y >= 0 && x < gw && y < gh) kept[y * gw + x] = 1;
                }
            }
        }
    }
    return kept;
}

// Panel candidates on the thick-only divider network. The mirror image of
// keepThickDividers: as a line too thin to be a gutter may not split a
// panel, content too thin to be art mass may not join two panels - a 1px
// line along the image's edge, or a hairline across a gutter, would
// otherwise merge every panel it touches into one page-sized component.
// Components are found on the thick parts of the content only; a panel's
// own thin outline comes back when tightenBox grows its edges. Beyond the
// image edge counts as not content, so a hairline along the edge isn't
// thick there either.
function labelPanels(dividers: Uint8Array, gw: number, gh: number, width: number, height: number): Box[] {
    const content = new Uint8Array(gw * gh);
    for (let i = 0; i < gw * gh; i++) content[i] = dividers[i] ? 0 : 1;
    const core = thickParts(content, gw, gh, 0);

    const label = new Int32Array(gw * gh).fill(-1);
    const queue = new Int32Array(gw * gh);
    const neighbors = (idx: number, visit: (n: number) => void) => {
        const gx = idx % gw;
        const gy = (idx / gw) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = gx + dx;
                const ny = gy + dy;
                if ((dx || dy) && nx >= 0 && ny >= 0 && nx < gw && ny < gh) visit(ny * gw + nx);
            }
        }
    };

    let count = 0;
    for (let start = 0; start < gw * gh; start++) {
        if (!core[start] || label[start] >= 0) continue;
        let head = 0;
        let tail = 0;
        label[start] = count;
        queue[tail++] = start;
        while (head < tail) {
            neighbors(queue[head++], n => {
                if (core[n] && label[n] < 0) {
                    label[n] = count;
                    queue[tail++] = n;
                }
            });
        }
        count++;
    }

    const bounds = Array.from({ length: count }, () => ({ minX: gw, minY: gh, maxX: -1, maxY: -1 }));
    for (let i = 0; i < gw * gh; i++) {
        if (label[i] < 0) continue;
        const b = bounds[label[i]];
        const gx = i % gw;
        const gy = (i / gw) | 0;
        if (gx < b.minX) b.minX = gx;
        if (gx > b.maxX) b.maxX = gx;
        if (gy < b.minY) b.minY = gy;
        if (gy > b.maxY) b.maxY = gy;
    }
    return bounds.map(b => {
        const left = b.minX * SAMPLE_STRIDE;
        const top = b.minY * SAMPLE_STRIDE;
        return {
            left,
            top,
            width: Math.min(b.maxX * SAMPLE_STRIDE + SAMPLE_STRIDE, width) - left,
            height: Math.min(b.maxY * SAMPLE_STRIDE + SAMPLE_STRIDE, height) - top
        };
    });
}

// A thin line may not split a panel, but it may still separate a panel
// from something that isn't part of it - a title line only 2-3px above the
// first panel, or a copyright line just as close below the last. On the
// thick-only network those get glued onto the panel. So each panel's final
// box is the union of the pieces the *full* network cut it into, counting
// only pieces that run across (nearly) the panel's whole width or height -
// slices of the panel itself, like the slivers between a door frame's edge
// lines or a strip cut off along a panel's edge by a drawn line. A caption
// beside the panel spans neither and stays outside. Trimming only ever
// removes such small additions: if the slices cover less than
// PANEL_SLICE_MIN_AREA_FRACTION of the panel, the panel stays as found.
const PANEL_SLICE_SPAN_FRACTION = 0.8;
const PANEL_SLICE_MIN_AREA_FRACTION = 0.5;

function trimToPanelSlices(panel: Box, pieces: Box[]): Box {
    const slices = pieces.filter(p =>
        p.left >= panel.left && p.top >= panel.top
        && p.left + p.width <= panel.left + panel.width
        && p.top + p.height <= panel.top + panel.height
        && (p.width >= panel.width * PANEL_SLICE_SPAN_FRACTION || p.height >= panel.height * PANEL_SLICE_SPAN_FRACTION));
    if (!slices.length) return panel;
    const trimmed = slices.reduce(mergeTwoBoxes);
    return trimmed.width * trimmed.height >= panel.width * panel.height * PANEL_SLICE_MIN_AREA_FRACTION ? trimmed : panel;
}

// Distance between two boxes plus whether they're row-neighbors (side by
// side, separated horizontally) or column-neighbors (stacked, separated
// vertically) - the alignment a genuine gutter runs along - or genuinely
// overlapping in both axes. Real art isn't a clean rectangle, so two
// separate connected components (e.g. two halves of one irregularly-shaped
// panel that only just touch at one corner) can easily have *bounding
// boxes* that overlap in both x and y even though their actual pixels
// never do - that's not evidence of two candidate panels sharing space,
// it's the same rectangle-approximation looseness MIN_PANEL_FRACTION
// already accepts, so it's always merged rather than run through either
// alignment check below.
function boxGapInfo(a: Box, b: Box): { gap: number; rowAligned: boolean; colAligned: boolean; overlapping: boolean } {
    const aRight = a.left + a.width;
    const aBottom = a.top + a.height;
    const bRight = b.left + b.width;
    const bBottom = b.top + b.height;

    const overlapY = Math.min(aBottom, bBottom) - Math.max(a.top, b.top);
    const overlapX = Math.min(aRight, bRight) - Math.max(a.left, b.left);

    const overlapping = overlapX > 0 && overlapY > 0;
    const rowAligned = !overlapping && overlapX <= 0 && overlapY > ALIGNMENT_OVERLAP_FRACTION * Math.min(a.height, b.height);
    const colAligned = !overlapping && overlapY <= 0 && overlapX > ALIGNMENT_OVERLAP_FRACTION * Math.min(a.width, b.width);

    const dx = Math.max(0, Math.max(a.left, b.left) - Math.min(aRight, bRight));
    const dy = Math.max(0, Math.max(a.top, b.top) - Math.min(aBottom, bBottom));
    const gap = Math.max(dx, dy);

    return { gap, rowAligned, colAligned, overlapping };
}

// Whether a and b are immediate neighbors along their shared alignment
// axis - i.e. no *other* box's rectangle sits in the gap between them. Two
// row-aligned boxes with a third box sandwiched between them are not a
// "gutter" pair (their combined span isn't a real gutter at all, just the
// distance across an unrelated third panel) - without this check, every
// same-row/column pair in an N-panel row would be compared, not just
// actual neighbors, and a distant pair's span would masquerade as a huge
// "disproportionate gap".
function isAdjacent(a: Box, b: Box, boxes: Box[]): boolean {
    const aRight = a.left + a.width;
    const aBottom = a.top + a.height;
    const bRight = b.left + b.width;
    const bBottom = b.top + b.height;
    const overlapY = Math.min(aBottom, bBottom) - Math.max(a.top, b.top);
    const overlapX = Math.min(aRight, bRight) - Math.max(a.left, b.left);

    let gapAxisIsX: boolean;
    let gapStart: number, gapEnd: number, crossStart: number, crossEnd: number;
    if (overlapX <= 0) {
        gapAxisIsX = true;
        gapStart = Math.min(aRight, bRight);
        gapEnd = Math.max(a.left, b.left);
        crossStart = Math.max(a.top, b.top);
        crossEnd = Math.min(aBottom, bBottom);
    } else if (overlapY <= 0) {
        gapAxisIsX = false;
        gapStart = Math.min(aBottom, bBottom);
        gapEnd = Math.max(a.top, b.top);
        crossStart = Math.max(a.left, b.left);
        crossEnd = Math.min(aRight, bRight);
    } else {
        return true;
    }

    for (const c of boxes) {
        if (c === a || c === b) continue;
        const cRight = c.left + c.width;
        const cBottom = c.top + c.height;
        const inGap = gapAxisIsX ? (c.left < gapEnd && cRight > gapStart) : (c.top < gapEnd && cBottom > gapStart);
        const crosses = gapAxisIsX ? (c.top < crossEnd && cBottom > crossStart) : (c.left < crossEnd && cRight > crossStart);
        if (inGap && crosses) return false;
    }
    return true;
}

function mergeTwoBoxes(a: Box, b: Box): Box {
    const left = Math.min(a.left, b.left);
    const top = Math.min(a.top, b.top);
    return {
        left,
        top,
        width: Math.max(a.left + a.width, b.left + b.width) - left,
        height: Math.max(a.top + a.height, b.top + b.height) - top
    };
}

function mergeBoxes(boxes: Box[]): Box[] {
    const current = boxes.slice();

    let changed = true;
    while (changed && current.length > 1) {
        changed = false;

        // Phase 1: any genuinely overlapping pair merges first, before every
        // fuzzier rule below - otherwise array order decides, and a fragment
        // that overlaps one panel's box could be absorbed into an unrelated
        // neighboring panel instead.
        overlapPass:
        for (let i = 0; i < current.length; i++) {
            for (let j = i + 1; j < current.length; j++) {
                if (boxGapInfo(current[i], current[j]).overlapping) {
                    const merged = mergeTwoBoxes(current[i], current[j]);
                    current.splice(j, 1);
                    current.splice(i, 1, merged);
                    changed = true;
                    break overlapPass;
                }
            }
        }
        if (changed) continue;

        // Phase 2: no overlaps remain - a row/column-neighboring pair with
        // a gap thinner than the sampling grid can meaningfully represent
        // (see MIN_MEANINGFUL_GUTTER_PX) merges. Nothing size- or ratio-
        // based: a gap wide enough to survive as a divider is trusted as one.
        fuzzyPass:
        for (let i = 0; i < current.length; i++) {
            for (let j = i + 1; j < current.length; j++) {
                const a = current[i];
                const b = current[j];
                const { gap, rowAligned, colAligned } = boxGapInfo(a, b);

                const shouldMerge = (rowAligned || colAligned) && isAdjacent(a, b, current) && gap < MIN_MEANINGFUL_GUTTER_PX;

                if (shouldMerge) {
                    const merged = mergeTwoBoxes(a, b);
                    current.splice(j, 1);
                    current.splice(i, 1, merged);
                    changed = true;
                    break fuzzyPass;
                }
            }
        }
    }
    return current;
}

// Top-to-bottom, then left-to-right within a row-ish band (boxes whose
// vertical center falls within the band-seeding box's own vertical span).
function sortReadingOrder(boxes: Box[]): Box[] {
    const remaining = boxes.slice().sort((a, b) => a.top - b.top);
    const rows: Box[][] = [];

    while (remaining.length) {
        const seed = remaining.shift()!;
        const rowTop = seed.top;
        const rowBottom = seed.top + seed.height;
        const row = [seed];
        for (let i = remaining.length - 1; i >= 0; i--) {
            const centerY = remaining[i].top + remaining[i].height / 2;
            if (centerY >= rowTop && centerY <= rowBottom) {
                row.push(remaining[i]);
                remaining.splice(i, 1);
            }
        }
        // Left position first, ties broken by top: a tall panel beside a
        // stacked pair of shorter ones puts all three in one row band (the
        // tall one seeds its span), and the stacked pair share the same
        // `left`.
        row.sort((a, b) => a.left - b.left || a.top - b.top);
        rows.push(row);
    }
    return rows.flat();
}

function detectPanelBoxes(data: Buffer, width: number, height: number, channels: number): Box[] {
    const minPanelWidth = Math.max(30, width * MIN_PANEL_FRACTION);
    const minPanelHeight = Math.max(30, height * MIN_PANEL_FRACTION);

    const gw = Math.ceil(width / SAMPLE_STRIDE);
    const gh = Math.ceil(height / SAMPLE_STRIDE);

    const colors = buildColorGrid(data, width, height, channels, gw, gh);
    const shape = computeLineShapeEvidence(colors, gw, gh);
    const marginColor = estimateMarginColor(colors, gw, gh);
    const reached = computeDividerNetwork(colors, gw, gh, marginColor, shape);
    const pieces = labelPanels(reached, gw, gh, width, height);

    let boxes = labelPanels(keepThickDividers(reached, gw, gh), gw, gh, width, height)
        .filter(b => b.width >= minPanelWidth && b.height >= minPanelHeight)
        .map(b => trimToPanelSlices(b, pieces));

    if (boxes.length < 2) return [];

    boxes = mergeBoxes(boxes);

    if (boxes.length < 2 || boxes.length > MAX_CANDIDATES) return [];

    const unionLeft = Math.min(...boxes.map(b => b.left));
    const unionTop = Math.min(...boxes.map(b => b.top));
    const unionRight = Math.max(...boxes.map(b => b.left + b.width));
    const unionBottom = Math.max(...boxes.map(b => b.top + b.height));
    const unionArea = (unionRight - unionLeft) * (unionBottom - unionTop);
    const coveredArea = boxes.reduce((sum, b) => sum + b.width * b.height, 0);
    if (unionArea <= 0 || coveredArea / unionArea < MIN_COVERAGE_FRACTION) return [];

    boxes = boxes.map(b => tightenBox(b, data, width, height, channels, marginColor));
    // Title bars/footers only ever sit on the page's outer edge.
    const pageTop = Math.min(...boxes.map(b => b.top));
    const pageBottom = Math.max(...boxes.map(b => b.top + b.height));
    boxes = boxes.map(b => {
        if (b.top <= pageTop + SAMPLE_STRIDE) b = trimTitleBand(b, data, width, channels, 'top', marginColor);
        if (b.top + b.height >= pageBottom - SAMPLE_STRIDE) b = trimTitleBand(b, data, width, channels, 'bottom', marginColor);
        return b;
    });
    return sortReadingOrder(boxes);
}

/**
 * Splits a downloaded page image into per-panel image files alongside it.
 * Returns the panel image paths in reading order (top-to-bottom, left-to-
 * right) and deletes the page image. If no confident multi-panel grid is
 * detected, the page image is left as is and returned as the only panel.
 */
export async function splitIntoPanels(imagePath: string): Promise<string[]> {
    const image = sharp(imagePath);
    const { width, height } = await image.metadata();
    if (!width || !height) return [imagePath];

    const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });

    const boxes = detectPanelBoxes(data, width, height, info.channels);
    if (boxes.length <= 1) return [imagePath];

    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = path.basename(imagePath, ext);

    const panelPaths: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
        const outPath = path.join(dir, `${base}_panel${i + 1}${ext}`);
        await sharp(imagePath).extract(boxes[i]).toFile(outPath);
        panelPaths.push(outPath);
    }

    fs.unlinkSync(imagePath);
    return panelPaths;
}

// Fraction of a box edge line's pixels that match the gutter color. `pos`
// is a column (vertical line, rows from..to) or a row (horizontal line).
function gutterFraction(data: Buffer, width: number, channels: number, gutter: RGB, vertical: boolean, pos: number, from: number, to: number): number {
    let matches = 0;
    for (let i = from; i < to; i++) {
        const idx = (vertical ? i * width + pos : pos * width + i) * channels;
        if (colorDistance(readPixel(data, idx, channels), gutter) <= GUTTER_TRIM_EPSILON) matches++;
    }
    return to > from ? matches / (to - from) : 1;
}

// Whether edge line `pos` is gutter or a gutter/border blend, judged
// against the line just inside it (`inner`).
function isShavableLine(data: Buffer, width: number, channels: number, gutter: RGB, vertical: boolean, pos: number, inner: number, from: number, to: number): boolean {
    let matches = 0;
    for (let i = from; i < to; i++) {
        const at = (p: number) => readPixel(data, (vertical ? i * width + p : p * width + i) * channels, channels);
        const d = colorDistance(at(pos), gutter);
        if (d <= GUTTER_TRIM_EPSILON || d <= colorDistance(at(inner), gutter) - BLEND_MIN_STEP) matches++;
    }
    return to > from && matches / (to - from) >= GUTTER_LINE_FRACTION;
}

// Shaves up to `maxPx` gutter (or gutter-blend) lines off each edge of a
// box.
function shaveGutterEdges(box: Box, data: Buffer, width: number, channels: number, gutter: RGB, maxPx: number): Box {
    let left = box.left;
    let top = box.top;
    let right = box.left + box.width;   // exclusive
    let bottom = box.top + box.height;  // exclusive
    const line = (vertical: boolean, pos: number, inner: number) =>
        isShavableLine(data, width, channels, gutter, vertical, pos, inner, vertical ? top : left, vertical ? bottom : right);

    for (let i = 0; i < maxPx && right - left > 2 && line(true, left, left + 1); i++) left++;
    for (let i = 0; i < maxPx && right - left > 2 && line(true, right - 1, right - 2); i++) right--;
    for (let i = 0; i < maxPx && bottom - top > 2 && line(false, top, top + 1); i++) top++;
    for (let i = 0; i < maxPx && bottom - top > 2 && line(false, bottom - 1, bottom - 2); i++) bottom--;

    return { left, top, width: right - left, height: bottom - top };
}

function tightenBox(box: Box, data: Buffer, width: number, height: number, channels: number, gutter: RGB): Box {
    let left = box.left;
    let top = box.top;
    let right = box.left + box.width;   // exclusive
    let bottom = box.top + box.height;  // exclusive
    const col = (x: number) => gutterFraction(data, width, channels, gutter, true, x, top, bottom);
    const row = (y: number) => gutterFraction(data, width, channels, gutter, false, y, left, right);

    for (let i = 0; i < MAX_EDGE_GROW_PX && left > 0 && col(left - 1) < 0.5; i++) left--;
    for (let i = 0; i < MAX_EDGE_GROW_PX && right < width && col(right) < 0.5; i++) right++;
    for (let i = 0; i < MAX_EDGE_GROW_PX && top > 0 && row(top - 1) < 0.5; i++) top--;
    for (let i = 0; i < MAX_EDGE_GROW_PX && bottom < height && row(bottom) < 0.5; i++) bottom++;

    return shaveGutterEdges({ left, top, width: right - left, height: bottom - top }, data, width, channels, gutter, MAX_EDGE_TRIM_PX);
}

// A title (or footer) glued to the page's outer panels: text on a band of
// one color - a bar on the panel's edge, or the page's own background -
// with too thin a gap to the panel for the divider network to separate
// them (letters reaching down almost to the panel). Recognized by shape:
// from the edge inward, a thin band (at most TITLE_BAND_MAX_PX and
// TITLE_BAND_MAX_FRACTION of the panel) where one color dominates but other
// pixels mix in - the text - and then a near-solid full-width line of that
// same color. The crop moves to the start of that line, so the panel keeps
// its edge. When the band is the page's own background color it's never
// part of a panel, so it also ends where its color stops dominating, line
// or not (a footer whose text sits right against the art). A plain frame
// (solid from the edge) or ordinary artwork doesn't have that shape. Artwork that looks similar (lettering or a bubble edge
// on the panel's own background, then a plain background row) is told
// apart by what follows: a bar or gutter ends after its line, a panel's own
// background carries on into the rows below. And every band row must look
// like text (isTextRow): nearly all pixels either the band's color or
// clearly contrasting with it, in thin strokes only - a speech bubble or
// dark artwork has wide shapes and in-between tones. Side frames aren't a
// usable signal: panel art often runs right to the edge.
const TITLE_BAND_MAX_PX = 30;
const TITLE_BAND_MAX_FRACTION = 0.1;
const TITLE_BAND_MIN_TEXT_ROWS = 2;
// In a text row the band's color is the most common one, but long or bold
// text can cover most of the row.
const TEXT_ROW_MIN_FRACTION = 0.2;
// A row after the band's line counts as still the band's color (so a
// background, not a bar) at this share.
const BAR_DOMINANT_FRACTION = 0.6;
// Antialiased letter edges keep the line under the text slightly short of
// fully solid.
const SOLID_LINE_FRACTION = 0.95;
// Rows checked after the solid line, and how many of them may still be
// dominated by the bar's color before it counts as background, not a bar.
const AFTER_BAR_ROWS = 10;
const AFTER_BAR_MAX_BAR_ROWS = 2;
const MAX_SOLID_RUN = 8;
// isTextRow: a pixel is the band's color within TEXT_BAND_EPSILON, clearly
// contrasting from TEXT_CONTRAST_DISTANCE; at least TEXT_TWO_TONE_FRACTION
// of the row is one or the other, and no contrasting run is wider than
// TEXT_MAX_STROKE_PX (lettering strokes stay under ~15px, bubbles and art
// are far wider).
const TEXT_BAND_EPSILON = 72;
const TEXT_CONTRAST_DISTANCE = 200;
const TEXT_TWO_TONE_FRACTION = 0.7;
const TEXT_MAX_STROKE_PX = 20;

// Most common color of one row (colors bucketed to 16 levels per channel).
function rowDominant(data: Buffer, width: number, channels: number, y: number, left: number, right: number): { key: number; fraction: number } {
    const counts = new Map<number, number>();
    let bestKey = 0;
    let best = 0;
    for (let x = left; x < right; x++) {
        const c = readPixel(data, (y * width + x) * channels, channels);
        const key = ((c.r >> 4) << 8) | ((c.g >> 4) << 4) | (c.b >> 4);
        const n = (counts.get(key) ?? 0) + 1;
        counts.set(key, n);
        if (n > best) { best = n; bestKey = key; }
    }
    return { key: bestKey, fraction: right > left ? best / (right - left) : 0 };
}


const bucketColor = (key: number): RGB => ({ r: ((key >> 8) & 15) * 16 + 8, g: ((key >> 4) & 15) * 16 + 8, b: (key & 15) * 16 + 8 });

function isTextRow(data: Buffer, width: number, channels: number, y: number, left: number, right: number, band: RGB): boolean {
    let twoTone = 0;
    let run = 0;
    for (let x = left; x < right; x++) {
        const d = colorDistance(readPixel(data, (y * width + x) * channels, channels), band);
        if (d <= TEXT_BAND_EPSILON) {
            twoTone++;
            run = 0;
            continue;
        }
        if (d >= TEXT_CONTRAST_DISTANCE) twoTone++;
        if (++run > TEXT_MAX_STROKE_PX) return false;
    }
    return twoTone / (right - left) >= TEXT_TWO_TONE_FRACTION;
}

function trimTitleBand(box: Box, data: Buffer, width: number, channels: number, edge: 'top' | 'bottom', gutter: RGB): Box {
    const maxBand = Math.min(TITLE_BAND_MAX_PX, Math.floor(box.height * TITLE_BAND_MAX_FRACTION));
    const step = edge === 'top' ? 1 : -1;
    const start = edge === 'top' ? box.top : box.top + box.height - 1;
    const row = (i: number) => rowDominant(data, width, channels, start + i * step, box.left, box.left + box.width);

    const first = row(0);
    if (first.fraction < TEXT_ROW_MIN_FRACTION) return box;
    let i = 0;
    // The bar's own solid padding before its text.
    while (i < maxBand && row(i).key === first.key && row(i).fraction >= SOLID_LINE_FRACTION) i++;
    const bandIsGutter = colorDistance(bucketColor(first.key), gutter) <= GUTTER_TRIM_EPSILON * 2;

    const cutAt = (n: number): Box => edge === 'top'
        ? { left: box.left, top: box.top + n, width: box.width, height: box.height - n }
        : { left: box.left, top: box.top, width: box.width, height: box.height - n };
    const bandColor = bucketColor(first.key);
    const textRow = (n: number) => isTextRow(data, width, channels, start + n * step, box.left, box.left + box.width, bandColor);
    let textRows = 0;
    while (i < maxBand) {
        const r = row(i);
        if (r.key !== first.key || r.fraction < TEXT_ROW_MIN_FRACTION) {
            return bandIsGutter && textRows >= TITLE_BAND_MIN_TEXT_ROWS ? cutAt(i) : box;
        }
        if (r.fraction >= SOLID_LINE_FRACTION) break;
        if (!textRow(i)) return box;
        textRows++;
        i++;
    }
    if (i >= maxBand || textRows < TITLE_BAND_MIN_TEXT_ROWS) return box;

    // Past the solid line, the bar's color has to give way to artwork.
    let j = i;
    while (j < i + MAX_SOLID_RUN && j < box.height && row(j).key === first.key && row(j).fraction >= SOLID_LINE_FRACTION) j++;
    let barRows = 0;
    for (let k = j; k < j + AFTER_BAR_ROWS && k < box.height; k++) {
        const r = row(k);
        if (r.key === first.key && r.fraction >= BAR_DOMINANT_FRACTION) barRows++;
    }
    if (barRows > AFTER_BAR_MAX_BAR_ROWS) return box;

    return cutAt(i);
}

// Exported for direct unit testing (raw pixel buffer in, candidate boxes
// out - no image codec needed to exercise the actual detection logic).
export { detectPanelBoxes };
