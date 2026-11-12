import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { ReadingDirection } from '../types';

/**
 * Automatic panel splitting for a downloaded comic page image.
 *
 * A page is cut along its gutters, and its panels are the cells between
 * them - nothing is fitted to the artwork:
 *
 * 1. The gutter colors (gutterColorSets): the page's margin color, read
 *    from its corners, and - for a page framed in that color (title bar,
 *    footer) - a second color whose long thin lines end at the frame or
 *    the image edge.
 * 2. A gutter is a band of at least MIN_GUTTER_PX lines straight across
 *    the area being cut, every line all one gutter color (at most
 *    CLEAN_LINE_NOISE of its pixels off, and not counting the last
 *    LINE_END_SLACK_PX at either end, where frame corners antialias into
 *    it).
 * 3. The page is cut into rows along its gutters, each row into columns,
 *    each column into rows and so on (partition), as long as every part is
 *    panel-sized. At the page level a part too small to be a panel at the
 *    top or bottom edge is the title or footer and is dropped (one clean
 *    line is enough to separate it), and the margin around everything is
 *    trimmed. Where the margin is only the page's frame around inner
 *    gutters of another color, it only counts as a gutter at the page level
 *    - inside a panel a band of that color is artwork (a night sky).
 * 4. A speech bubble crossing a gutter doesn't block it (findBubbles): the
 *    cell holding most of the bubble takes it in whole, and the rest of the
 *    strip that adds is painted in the gutter color (withBubbles). A
 *    panel's sides along gutters lose a pixel (insetFromGutters) and the
 *    antialiased blend lines between gutter and frame (trimBlendLines).
 * 5. The cells are read row by row, the columns of a row in the comic's
 *    reading direction (sortReadingOrder). A row whose gutter is blocked in
 *    one column but cut in the next can't be read in order (a bubble ties
 *    panels 2 and 4 together across panel 3's row): such a page stays
 *    whole (rowsBrokenAcrossColumns).
 *
 * The whole page as one panel is always a valid result and the fallback:
 * an unsplit page is a minor inconvenience, a false split a broken one.
 */

// ---------------------------------------------------------------------------
// Types and pixel access
// ---------------------------------------------------------------------------

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

// The decoded page, and its speech bubbles (findBubbles).
interface Raster {
    data: Buffer;
    width: number;
    height: number;
    channels: number;
    bubbles: Bubble[];
    // Per pixel: 1 inside a bubble or its outline (BUBBLE_MARGIN_PX).
    bubbleMask: Uint8Array;
}

// Reads the color at byte offset `idx` regardless of the source image's
// native channel count (1 = greyscale, 2 = greyscale+alpha, 3 = RGB, 4 =
// RGBA) - a paletted/greyscale PNG is handled like a full-color one.
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

// The color of pixel `p` (y * width + x).
function pixelAt(r: Raster, p: number): RGB {
    return readPixel(r.data, p * r.channels, r.channels);
}

// colorDistance(pixelAt(r, p), color), without allocating.
function distanceAt(r: Raster, p: number, color: RGB): number {
    const i = p * r.channels;
    const grey = r.channels === 1 || r.channels === 2;
    const dr = r.data[i] - color.r;
    const dg = (grey ? r.data[i] : r.data[i + 1]) - color.g;
    const db = (grey ? r.data[i] : r.data[i + 2]) - color.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
}

// ---------------------------------------------------------------------------
// 1. The gutter colors
// ---------------------------------------------------------------------------

// The gutter colors are read on a grid sampled every SAMPLE_STRIDE pixels.
const SAMPLE_STRIDE = 2;
// Two sampled cells this close count as the same color - loose enough for
// a palette-dithered white ((255,255,255) beside (247,247,255), ~11 apart).
const SAME_COLOR_EPSILON = 12;
// The thinnest line the sampled grid tells apart from noise.
const MIN_GRID_LINE_PX = SAMPLE_STRIDE * 2;

// One RGB sample per cell (gw x gh).
interface SampleGrid {
    colors: RGB[];
    gw: number;
    gh: number;
}

function buildGrid(r: Raster): SampleGrid {
    const gw = Math.ceil(r.width / SAMPLE_STRIDE);
    const gh = Math.ceil(r.height / SAMPLE_STRIDE);
    const colors: RGB[] = new Array(gw * gh);
    for (let gy = 0; gy < gh; gy++) {
        const y = Math.min(gy * SAMPLE_STRIDE, r.height - 1);
        for (let gx = 0; gx < gw; gx++) {
            const x = Math.min(gx * SAMPLE_STRIDE, r.width - 1);
            colors[gy * gw + gx] = pixelAt(r, y * r.width + x);
        }
    }
    return { colors, gw, gh };
}

function colorMask(grid: SampleGrid, color: RGB): Uint8Array {
    const mask = new Uint8Array(grid.colors.length);
    for (let i = 0; i < grid.colors.length; i++) mask[i] = colorDistance(grid.colors[i], color) <= SAME_COLOR_EPSILON ? 1 : 0;
    return mask;
}

// Grows `reached` (cells of a w x h grid, in place) from its set cells into
// 8-connected cells that `canEnter`.
function grow8(reached: Uint8Array, w: number, h: number, canEnter: (i: number) => boolean): Uint8Array {
    const queue = new Int32Array(w * h);
    let head = 0;
    let tail = 0;
    for (let i = 0; i < w * h; i++) if (reached[i]) queue[tail++] = i;
    while (head < tail) {
        const idx = queue[head++];
        const x = idx % w;
        const y = (idx / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx;
                const ny = y + dy;
                if (!(dx || dy) || nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                const n = ny * w + nx;
                if (!reached[n] && canEnter(n)) {
                    reached[n] = 1;
                    queue[tail++] = n;
                }
            }
        }
    }
    return reached;
}

// The cells of `mask` (w x h) inside some fully-set side x side block, via
// two summed-area tables (block corners, then cells covered by a corner).
function insideSolidSquare(mask: Uint8Array, w: number, h: number, side: number): Uint8Array {
    const sat = (values: ArrayLike<number>): Int32Array => {
        const s = new Int32Array((w + 1) * (h + 1));
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                s[(y + 1) * (w + 1) + x + 1] = values[y * w + x] + s[y * (w + 1) + x + 1] + s[(y + 1) * (w + 1) + x] - s[y * (w + 1) + x];
            }
        }
        return s;
    };
    const sum = (s: Int32Array, x0: number, y0: number, x1: number, y1: number) =>
        s[y1 * (w + 1) + x1] - s[y0 * (w + 1) + x1] - s[y1 * (w + 1) + x0] + s[y0 * (w + 1) + x0];

    const maskSat = sat(mask);
    const corners = new Uint8Array(w * h);
    for (let y = 0; y + side <= h; y++) {
        for (let x = 0; x + side <= w; x++) {
            if (sum(maskSat, x, y, x + side, y + side) === side * side) corners[y * w + x] = 1;
        }
    }
    const cornerSat = sat(corners);
    const inside = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (sum(cornerSat, Math.max(0, x - side + 1), Math.max(0, y - side + 1), x + 1, y + 1) > 0) inside[y * w + x] = 1;
        }
    }
    return inside;
}

// The cells of `mask` in some fully-set k x k block (k cells =
// MIN_GRID_LINE_PX): the mask without its 1px lines. Beyond the grid
// counts as set.
function thickParts(mask: Uint8Array, gw: number, gh: number): Uint8Array {
    const k = Math.max(1, Math.round(MIN_GRID_LINE_PX / SAMPLE_STRIDE));
    const at = (x: number, y: number) => (x < 0 || y < 0 || x >= gw || y >= gh) ? 1 : mask[y * gw + x];
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

// A cell is part of a long thin line if, along one axis, it is in a
// same-color run at least LINE_MIN_LENGTH_FRACTION of the page long, at
// most LINE_MAX_THICKNESS_FRACTION thick across it.
const LINE_MIN_LENGTH_FRACTION = 0.3;
const LINE_MAX_THICKNESS_FRACTION = 0.1;

// For every cell, the length of the same-color run it belongs to along one
// axis.
function computeRuns(grid: SampleGrid, horizontal: boolean): Int32Array {
    const { colors, gw, gh } = grid;
    const sameColor = (i: number, j: number) => colorDistance(colors[i], colors[j]) <= SAME_COLOR_EPSILON;
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

// The mode color among the image's four corners. Not a vote over the whole
// border - panels often run flush to the left/right edges, outnumbering a
// thin top/bottom margin. A panel is very unlikely to occupy all four
// corners at once.
function estimateMarginColor(grid: SampleGrid): RGB {
    const { colors, gw, gh } = grid;
    const cornerSize = Math.max(1, Math.min(6, Math.floor(gw / 6), Math.floor(gh / 6)));
    const histR = new Array(256).fill(0);
    const histG = new Array(256).fill(0);
    const histB = new Array(256).fill(0);
    const addCorner = (left: number, top: number) => {
        for (let dy = 0; dy < cornerSize; dy++) {
            for (let dx = 0; dx < cornerSize; dx++) {
                const c = colors[(top + dy) * gw + (left + dx)];
                histR[c.r]++;
                histG[c.g]++;
                histB[c.b]++;
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

// Candidates for a second, inner gutter color on a page framed in its
// margin color: cells of a long thin line in another color, touching the
// frame (the margin color's area grown from the image edge, without its
// thin lines) or the image edge - a gutter's ends - grouped by color, most
// frequent first. A cell inside a solid area of its color is a panel
// background touching the frame, not a gutter's end: a gutter, even where
// two cross, never holds a solid square of INNER_GUTTER_SOLID_PX.
const INNER_GUTTER_SOLID_PX = 24;
const MAX_INNER_GUTTER_GROUPS_CHECKED = 12;
const MIN_INNER_GUTTER_SEED_CELLS = 2;

function innerGutterColors(grid: SampleGrid, marginColor: RGB): RGB[] {
    const { colors, gw, gh } = grid;
    const hRun = computeRuns(grid, true);
    const vRun = computeRuns(grid, false);
    const minLenH = LINE_MIN_LENGTH_FRACTION * gw;
    const minLenV = LINE_MIN_LENGTH_FRACTION * gh;
    const maxThicknessH = LINE_MAX_THICKNESS_FRACTION * gh;
    const maxThicknessV = LINE_MAX_THICKNESS_FRACTION * gw;

    const isMargin = colorMask(grid, marginColor);
    const margin = new Uint8Array(gw * gh);
    for (let gx = 0; gx < gw; gx++) {
        for (const gy of [0, gh - 1]) if (isMargin[gy * gw + gx]) margin[gy * gw + gx] = 1;
    }
    for (let gy = 0; gy < gh; gy++) {
        for (const gx of [0, gw - 1]) if (isMargin[gy * gw + gx]) margin[gy * gw + gx] = 1;
    }
    const frame = thickParts(grow8(margin, gw, gh, i => !!isMargin[i]), gw, gh);

    const touchesFrame = (gx: number, gy: number) => {
        if (gx === 0 || gy === 0 || gx === gw - 1 || gy === gh - 1) return true;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if (frame[(gy + dy) * gw + gx + dx]) return true;
            }
        }
        return false;
    };
    const groups: { color: RGB; seeds: number[] }[] = [];
    for (let gy = 0; gy < gh; gy++) {
        for (let gx = 0; gx < gw; gx++) {
            const i = gy * gw + gx;
            const horizontal = hRun[i] >= minLenH && vRun[i] <= maxThicknessH;
            const vertical = vRun[i] >= minLenV && hRun[i] <= maxThicknessV;
            if (!(horizontal || vertical) || frame[i] || isMargin[i] || !touchesFrame(gx, gy)) continue;
            const group = groups.find(g => colorDistance(g.color, colors[i]) <= SAME_COLOR_EPSILON);
            if (group) group.seeds.push(i);
            else groups.push({ color: colors[i], seeds: [i] });
        }
    }
    const solidCells = Math.round(INNER_GUTTER_SOLID_PX / SAMPLE_STRIDE);
    return groups
        .sort((a, b) => b.seeds.length - a.seeds.length)
        .slice(0, MAX_INNER_GUTTER_GROUPS_CHECKED)
        .map(g => {
            const solid = insideSolidSquare(colorMask(grid, g.color), gw, gh, solidCells);
            return { color: g.color, seeds: g.seeds.filter(i => !solid[i]).length };
        })
        .filter(g => g.seeds >= MIN_INNER_GUTTER_SEED_CELLS)
        .sort((a, b) => b.seeds - a.seeds)
        .map(g => g.color);
}

// The gutter colors to try, each as the colors a gutter may have at the
// page level and inside it: the margin color alone, and the margin with
// each inner gutter color - there the margin is the page's frame, and
// inside the page only the inner color divides.
interface GutterColors {
    page: RGB[];
    inside: RGB[];
}

function gutterColorSets(r: Raster): GutterColors[] {
    const grid = buildGrid(r);
    const margin = estimateMarginColor(grid);
    return [
        { page: [margin], inside: [margin] },
        ...innerGutterColors(grid, margin).map(inner => ({ page: [margin, inner], inside: [inner] }))
    ];
}

// ---------------------------------------------------------------------------
// 2-3. Cutting along the gutters
// ---------------------------------------------------------------------------

// A gutter pixel is within this distance of its gutter color: JPEG noise
// and palette dithering, but not a cream or pale blue panel background
// next to a white gutter (~22 and up).
const GUTTER_TOLERANCE = 16;
// A clean line may have this share of its pixels off its color (stray
// noise); a bubble outline crossing a gutter is more.
const CLEAN_LINE_NOISE = 0.003;
const MIN_GUTTER_PX = 2;
const TITLE_LINE_NOISE = 0.01;
const LINE_END_SLACK_PX = 3;
// Parts smaller than this fraction of the page (or MIN_PANEL_PX) aren't
// panels.
const MIN_PANEL_FRACTION = 0.08;
const MIN_PANEL_PX = 30;
const MAX_PANELS = 16;
// A cell this nearly all gutter color holds no panel.
const EMPTY_CELL_FRACTION = 0.99;
const MOSTLY_GUTTER = 0.8;
// A row gutter counts as present but blocked in a column where at least
// this share of its pixels is gutter color.
const BLOCKED_GUTTER_FRACTION = 0.5;

interface Band {
    from: number;
    to: number;
}

// One node of the cut: a leaf is a panel, a split holds its parts (top to
// bottom, or left to right) and the gutters between them.
interface Node {
    box: Box;
    split?: { columns: boolean; parts: Node[]; gutters: Band[] };
}

// Whether a line (a row: y = pos, or a column: x = pos) is clean from
// `from` to `to` in one of `colors` - with `ignoreBubbles`, not counting
// speech bubbles, which may cross a gutter (see findGutters).
function isCleanLine(r: Raster, column: boolean, pos: number, from: number, to: number, colors: RGB[], noise = CLEAN_LINE_NOISE, ignoreBubbles = false): boolean {
    const allowed = Math.floor((to - from) * noise);
    // Where gutters meet, frame corners antialias into the line's ends.
    const inFrom = Math.min(from + LINE_END_SLACK_PX, to);
    const inTo = Math.max(to - LINE_END_SLACK_PX, inFrom);
    for (const color of colors) {
        let off = 0;
        for (let i = inFrom; i < inTo && off <= allowed; i++) {
            const p = column ? i * r.width + pos : pos * r.width + i;
            if (!(ignoreBubbles && r.bubbleMask[p]) && distanceAt(r, p, color) > GUTTER_TOLERANCE) off++;
        }
        if (off <= allowed) return true;
    }
    return false;
}

// Share of an area's pixels in one of `colors` - with `bubbles`, counting
// speech bubbles as gutter color too.
function gutterShare(r: Raster, box: Box, colors: RGB[], bubbles = false): number {
    let count = 0;
    for (let y = box.top; y < box.top + box.height; y++) {
        for (let x = box.left; x < box.left + box.width; x++) {
            const p = y * r.width + x;
            if ((bubbles && r.bubbleMask[p]) || colors.some(c => distanceAt(r, p, c) <= GUTTER_TOLERANCE)) count++;
        }
    }
    return box.width * box.height > 0 ? count / (box.width * box.height) : 1;
}

// Whether an area holds speech bubbles and nothing else: a bubble on a
// panel's own background, cut off by a gap beside it, is no panel.
function onlyBubbles(r: Raster, box: Box, colors: RGB[]): boolean {
    // The bubble's shape, without the outline margin that may reach into
    // the gap.
    const m = BUBBLE_MARGIN_PX;
    const inside = (b: Bubble) => b.box.left + m >= box.left && b.box.top + m >= box.top
        && b.box.left + b.box.width - m <= box.left + box.width && b.box.top + b.box.height - m <= box.top + box.height;
    return r.bubbles.some(inside) && gutterShare(r, box, colors, true) >= EMPTY_CELL_FRACTION;
}

// The area without its clean edge lines: the page margin.
function trimMargin(r: Raster, box: Box, colors: RGB[]): Box {
    let left = box.left;
    let top = box.top;
    let right = box.left + box.width;
    let bottom = box.top + box.height;
    while (top < bottom && isCleanLine(r, false, top, left, right, colors)) top++;
    while (bottom > top && isCleanLine(r, false, bottom - 1, left, right, colors)) bottom--;
    while (left < right && isCleanLine(r, true, left, top, bottom, colors)) left++;
    while (right > left && isCleanLine(r, true, right - 1, top, bottom, colors)) right--;
    return { left, top, width: right - left, height: bottom - top };
}

// The gutters across a box along one axis: runs of at least `minLength`
// clean lines, not at its edge - and, where a speech bubble crosses a
// gutter, runs clean apart from the bubble, at most half under bubbles
// (bubbleShare), that lie between drawn panel frames (isFramed).
function findGutters(r: Raster, box: Box, columns: boolean, colors: RGB[], minLength: number, noise = CLEAN_LINE_NOISE): Band[] {
    const from = columns ? box.top : box.left;
    const to = columns ? box.top + box.height : box.left + box.width;
    const clean = cleanRuns(r, box, columns, colors, minLength, noise, false);
    const crossed = cleanRuns(r, box, columns, colors, minLength, noise, true)
        .filter(b => !clean.some(c => c.from < b.to && c.to > b.from) && bubbleShare(r, b, columns, from, to) <= MAX_BUBBLE_SHARE
            && isFramed(r, b, columns, from, to, colors));
    return [...clean, ...crossed].sort((x, y) => x.from - y.from);
}

function cleanRuns(r: Raster, box: Box, columns: boolean, colors: RGB[], minLength: number, noise: number, ignoreBubbles: boolean): Band[] {
    const start = columns ? box.left : box.top;
    const end = columns ? box.left + box.width : box.top + box.height;
    const from = columns ? box.top : box.left;
    const to = columns ? box.top + box.height : box.left + box.width;
    const bands: Band[] = [];
    let runStart = -1;
    for (let p = start; p <= end; p++) {
        const isClean = p < end && isCleanLine(r, columns, p, from, to, colors, noise, ignoreBubbles);
        if (isClean && runStart < 0) runStart = p;
        if (!isClean && runStart >= 0) {
            if (p - runStart >= minLength && runStart > start && p < end) bands.push({ from: runStart, to: p });
            runStart = -1;
        }
    }
    return bands;
}

// Share of a band's pixels under bubbles. A bubble crosses a gutter over
// part of its length; a band mostly hidden under bubbles is a gap in the
// artwork that happens to be clean where it shows.
const MAX_BUBBLE_SHARE = 0.5;

function bubbleShare(r: Raster, band: Band, columns: boolean, from: number, to: number): number {
    let masked = 0;
    for (let p = band.from; p < band.to; p++) {
        for (let i = from; i < to; i++) if (r.bubbleMask[columns ? i * r.width + p : p * r.width + i]) masked++;
    }
    return masked / Math.max(1, (band.to - band.from) * (to - from));
}

// A band clean only apart from a bubble crossing it must lie between drawn
// panel frames: on both sides, within FRAME_SEARCH_PX, a line mostly
// (FRAME_LINE_FRACTION, outside bubbles) clearly not gutter color. A light
// panel background a bubble sits on has no such lines, so a bubble never
// turns it into a gutter.
const FRAME_SEARCH_PX = 4;
const FRAME_LINE_FRACTION = 0.6;
const FRAME_CONTRAST = 120;

function isFramed(r: Raster, band: Band, columns: boolean, from: number, to: number, colors: RGB[]): boolean {
    const limit = columns ? r.width : r.height;
    const frameLine = (pos: number) => {
        let dark = 0;
        let counted = 0;
        for (let i = from; i < to; i++) {
            const p = columns ? i * r.width + pos : pos * r.width + i;
            if (r.bubbleMask[p]) continue;
            counted++;
            if (colors.every(c => distanceAt(r, p, c) >= FRAME_CONTRAST)) dark++;
        }
        return counted > 0 && dark >= counted * FRAME_LINE_FRACTION;
    };
    const side = (startPos: number, dir: number) => {
        for (let k = 0; k < FRAME_SEARCH_PX; k++) {
            const pos = startPos + dir * k;
            if (pos < 0 || pos >= limit) return false;
            if (frameLine(pos)) return true;
        }
        return false;
    };
    return side(band.from - 1, -1) && side(band.to, 1);
}

// Cuts `box` along its gutters, rows first: the parts between gutters,
// each at least panel-sized. At the page level, a too-small part at the
// top or bottom edge (the title, the footer) is dropped instead; anywhere
// else, a too-small part joins its smaller neighbor (the gutter between
// them isn't cut).
function partition(r: Raster, box: Box, colors: GutterColors, minSize: { width: number; height: number }, pageLevel: boolean, mergeText: boolean): Node {
    const gutterColors = pageLevel ? colors.page : colors.inside;
    for (const columns of [false, true]) {
        const minPart = columns ? minSize.width : minSize.height;
        const start = columns ? box.left : box.top;
        const end = columns ? box.left + box.width : box.top + box.height;
        let first = start;
        let last = end;
        if (pageLevel && !columns) {
            // The title and footer: one line is enough to separate them,
            // and their lettering's descenders may reach down to the
            // panels (TITLE_LINE_NOISE).
            const lines = findGutters(r, box, false, gutterColors, 1, TITLE_LINE_NOISE);
            while (lines.length && lines[0].from - first < minPart) first = lines.shift()!.to;
            while (lines.length && last - lines[lines.length - 1].to < minPart) last = lines.pop()!.from;
        }
        const gutters = findGutters(r, box, columns, gutterColors, MIN_GUTTER_PX)
            .filter(g => g.from >= first && g.to <= last);
        if (!gutters.length && first === start && last === end) continue;
        for (;;) {
            const bounds = [first, ...gutters.flatMap(g => [g.from, g.to]), last];
            let smallest = -1;
            let smallestLength = minPart;
            for (let i = 0; i < bounds.length; i += 2) {
                const length = bounds[i + 1] - bounds[i];
                if (length < smallestLength) {
                    smallest = i / 2;
                    smallestLength = length;
                }
            }
            if (smallest < 0 || !gutters.length) break;
            const before = smallest > 0 ? bounds[smallest * 2 - 1] - bounds[smallest * 2 - 2] : Infinity;
            const after = smallest < gutters.length ? bounds[smallest * 2 + 3] - bounds[smallest * 2 + 2] : Infinity;
            gutters.splice(before <= after ? smallest - 1 : smallest, 1);
        }
        // Two parts both nearly all gutter color - lines of text on a
        // white panel, a form's boxes - are one panel: the gap between
        // them is no gutter, unless drawn frames line it (line-art panels
        // are mostly white too). Nor is the gap beside a part holding
        // only speech bubbles (onlyBubbles).
        const partBox = (from: number, to: number): Box => columns
            ? { left: from, top: box.top, width: to - from, height: box.height }
            : { left: box.left, top: from, width: box.width, height: to - from };
        for (let i = 0; i < gutters.length;) {
            const before = partBox(i ? gutters[i - 1].to : first, gutters[i].from);
            const after = partBox(gutters[i].to, i + 1 < gutters.length ? gutters[i + 1].from : last);
            const text = gutterShare(r, before, colors.inside) >= MOSTLY_GUTTER && gutterShare(r, after, colors.inside) >= MOSTLY_GUTTER
                && !isFramed(r, gutters[i], columns, columns ? box.top : box.left, columns ? box.top + box.height : box.left + box.width, gutterColors);
            if (mergeText && (text || onlyBubbles(r, before, colors.inside) || onlyBubbles(r, after, colors.inside))) {
                gutters.splice(i, 1);
                i = 0;
            } else {
                i++;
            }
        }
        if (!gutters.length && first === start && last === end) continue;

        const edges = [first, ...gutters.flatMap(g => [g.from, g.to]), last];
        const parts: Node[] = [];
        for (let i = 0; i < edges.length; i += 2) {
            const part: Box = columns
                ? { left: edges[i], top: box.top, width: edges[i + 1] - edges[i], height: box.height }
                : { left: box.left, top: edges[i], width: box.width, height: edges[i + 1] - edges[i] };
            // Dropping the title and footer leaves the page level, as does
            // any cut.
            parts.push(partition(r, part, colors, minSize, pageLevel && gutters.length === 0, mergeText));
        }
        if (parts.length === 1) return parts[0];
        return { box, split: { columns, parts, gutters } };
    }
    return { box };
}

// Whether a split into columns cuts a row gutter in one column that is
// present but blocked in a neighbor - a bubble across it: the panels can't
// be read row by row, whatever the order.
function rowsBrokenAcrossColumns(r: Raster, node: Node, colors: RGB[]): boolean {
    const split = node.split;
    if (!split) return false;
    if (split.columns) {
        for (const part of split.parts) {
            if (!part.split || part.split.columns) continue;
            for (const gutter of part.split.gutters) {
                for (const other of split.parts) {
                    if (other === part || hasRowGutter(other, gutter)) continue;
                    const band: Box = { left: other.box.left, top: gutter.from, width: other.box.width, height: gutter.to - gutter.from };
                    if (gutterShare(r, band, colors) >= BLOCKED_GUTTER_FRACTION) return true;
                }
            }
        }
    }
    return split.parts.some(p => rowsBrokenAcrossColumns(r, p, colors));
}

// Whether a node is itself cut into rows at a gutter overlapping `gutter`.
function hasRowGutter(node: Node, gutter: Band): boolean {
    const split = node.split;
    if (!split || split.columns) return false;
    return split.gutters.some(g => g.from < gutter.to && g.to > gutter.from);
}

function leaves(node: Node): Box[] {
    return node.split ? node.split.parts.flatMap(leaves) : [node.box];
}

// The panels for one choice of gutter colors, or [] for none.
function panelsWith(r: Raster, colors: GutterColors): Box[] {
    const page = trimMargin(r, { left: 0, top: 0, width: r.width, height: r.height }, colors.page);
    if (page.width <= 0 || page.height <= 0) return [];
    const minSize = {
        width: Math.max(MIN_PANEL_PX, r.width * MIN_PANEL_FRACTION),
        height: Math.max(MIN_PANEL_PX, r.height * MIN_PANEL_FRACTION)
    };
    // Joining text gaps never makes a page readable in order that wasn't:
    // the order check also runs on the cut without it.
    if (rowsBrokenAcrossColumns(r, partition(r, page, colors, minSize, true, false), colors.inside)) return [];
    const root = partition(r, page, colors, minSize, true, true);
    if (rowsBrokenAcrossColumns(r, root, colors.inside)) return [];
    // Too many cells to be panels before any are joined: no split.
    if (leaves(root).length > MAX_PANELS) return [];
    const widths = gutterWidths(root).sort((a, b) => a - b);
    if (widths.length) alignGutters(r, root, colors.inside, widths[(widths.length - 1) >> 1]);
    let cells = leaves(root).filter(b => gutterShare(r, b, colors.inside) < EMPTY_CELL_FRACTION);
    if (cells.length < 2 || cells.length > MAX_PANELS) return [];
    // Inner gutters in another color than the page's margin may continue
    // as a frame around the whole panel area (a black frame on a white
    // page): the cut leaves it on the panels' outer sides only.
    const outer = colors.inside.filter(c => !colors.page.slice(0, 1).some(m => colorDistance(c, m) <= SAME_COLOR_EPSILON));
    if (outer.length) {
        const widest = Math.max(MIN_GUTTER_PX, ...gutterWidths(root));
        cells = cells.map(c => trimOuterFrame(r, c, page, outer, widest));
    }
    return cells;
}

// A band with no panel edge on either side (PANEL_EDGE_FRACTION) - only
// scattered content on a background in the gutter color - may as well be
// empty space inside one frameless panel, whatever its width: its two parts
// are joined. Where one side has an edge, the band is a real gutter, but a
// frameless panel whose background is the gutter color makes it look too
// wide: gutters on a page are about the same width, so it keeps the page's
// usual width (the median) beside the edge, and the rest of the band is the
// frameless panel's background.

function alignGutters(r: Raster, node: Node, colors: RGB[], width: number): void {
    const split = node.split;
    if (!split) return;
    split.parts.forEach(p => alignGutters(r, p, colors, width));
    for (let i = 0; i < split.gutters.length;) {
        const g = split.gutters[i];
        const before = split.parts[i];
        const after = split.parts[i + 1];
        const beforeEdge = hasEdge(r, before.box, split.columns, g.from - 1, -1, colors);
        const afterEdge = hasEdge(r, after.box, split.columns, g.to, 1, colors);
        if (!beforeEdge && !afterEdge && !before.split && !after.split) {
            const b = before.box;
            const a = after.box;
            const left = Math.min(b.left, a.left);
            const top = Math.min(b.top, a.top);
            const box = {
                left,
                top,
                width: Math.max(b.left + b.width, a.left + a.width) - left,
                height: Math.max(b.top + b.height, a.top + a.height) - top
            };
            split.parts.splice(i, 2, { box });
            split.gutters.splice(i, 1);
            continue;
        }
        if ((beforeEdge && afterEdge) || g.to - g.from <= width) {
            i++;
            continue;
        }
        const from = beforeEdge ? g.from : afterEdge ? g.to - width : Math.round((g.from + g.to - width) / 2);
        const moved = { from, to: from + width };
        if (moved.from > g.from) moveEdge(before, split.columns, 'end', moved.from);
        if (moved.to < g.to) moveEdge(after, split.columns, 'start', moved.to);
        split.gutters[i] = moved;
        i++;
    }
    if (split.parts.length === 1) delete node.split;
}

// Whether a panel has its own edge along a gutter - a frame, or artwork
// ending straight - rather than scattered content on a background in the
// gutter color: one of its lines next to the gutter (from x = pos for a
// column cut, else y, EDGE_LINES inward in direction `dir`, past
// antialiasing) is mostly content.
const PANEL_EDGE_FRACTION = 0.5;
const EDGE_LINES = 3;

function hasEdge(r: Raster, box: Box, columns: boolean, pos: number, dir: number, colors: RGB[]): boolean {
    const from = columns ? box.top : box.left;
    const to = columns ? box.top + box.height : box.left + box.width;
    const limit = columns ? r.width : r.height;
    for (let k = 0; k < EDGE_LINES; k++) {
        const line = pos + dir * k;
        if (line < 0 || line >= limit) break;
        let content = 0;
        for (let i = from; i < to; i++) {
            const p = columns ? i * r.width + line : line * r.width + i;
            if (colors.every(c => distanceAt(r, p, c) > GUTTER_TOLERANCE)) content++;
        }
        if (content >= (to - from) * PANEL_EDGE_FRACTION) return true;
    }
    return false;
}

// Moves a node's start or end edge along one axis to `pos`, with every part
// on that edge.
function moveEdge(node: Node, columns: boolean, side: 'start' | 'end', pos: number): void {
    const b = node.box;
    if (columns) {
        if (side === 'start') {
            b.width += b.left - pos;
            b.left = pos;
        } else {
            b.width = pos - b.left;
        }
    } else if (side === 'start') {
        b.height += b.top - pos;
        b.top = pos;
    } else {
        b.height = pos - b.top;
    }
    const split = node.split;
    if (!split) return;
    if (split.columns === columns) moveEdge(split.parts[side === 'start' ? 0 : split.parts.length - 1], columns, side, pos);
    else split.parts.forEach(p => moveEdge(p, columns, side, pos));
}

// The widths of the gutters the cut went along.
function gutterWidths(node: Node): number[] {
    if (!node.split) return [];
    return [...node.split.gutters.map(g => g.to - g.from), ...node.split.parts.flatMap(gutterWidths)];
}

// A cell's sides on the panel area's outer edge, without up to `max`
// clean lines in `colors` there.
const OUTER_FRAME_TOLERANCE = 48;

function trimOuterFrame(r: Raster, cell: Box, area: Box, colors: RGB[], max: number): Box {
    let left = cell.left;
    let top = cell.top;
    let right = cell.left + cell.width;
    let bottom = cell.top + cell.height;
    // The frame's outermost lines are often antialiased toward the image
    // edge: OUTER_FRAME_TOLERANCE.
    const clean = (column: boolean, pos: number) => {
        const from = column ? top : left;
        const to = column ? bottom : right;
        const allowed = Math.floor((to - from) * CLEAN_LINE_NOISE);
        return colors.some(c => {
            let off = 0;
            for (let i = from; i < to && off <= allowed; i++) {
                if (distanceAt(r, column ? i * r.width + pos : pos * r.width + i, c) > OUTER_FRAME_TOLERANCE) off++;
            }
            return off <= allowed;
        });
    };
    if (left === area.left) for (let k = 0; k < max && right - left > 2 && clean(true, left); k++) left++;
    if (right === area.left + area.width) for (let k = 0; k < max && right - left > 2 && clean(true, right - 1); k++) right--;
    if (top === area.top) for (let k = 0; k < max && bottom - top > 2 && clean(false, top); k++) top++;
    if (bottom === area.top + area.height) for (let k = 0; k < max && bottom - top > 2 && clean(false, bottom - 1); k++) bottom--;
    return { left, top, width: right - left, height: bottom - top };
}

// Every side bordering a gutter (not the image edge) loses GUTTER_INSET_PX:
// the last line before a gutter is often a light antialias line, partly
// blended and partly art, that shows as a thin light line in a dark
// reader. Losing a pixel of art there is invisible.
const GUTTER_INSET_PX = 1;

function insetFromGutters(r: Raster, cell: Box): Box {
    const i = GUTTER_INSET_PX;
    const left = cell.left > 0 ? cell.left + i : cell.left;
    const top = cell.top > 0 ? cell.top + i : cell.top;
    const right = cell.left + cell.width < r.width ? cell.left + cell.width - i : cell.left + cell.width;
    const bottom = cell.top + cell.height < r.height ? cell.top + cell.height - i : cell.top + cell.height;
    return { left, top, width: right - left, height: bottom - top };
}

// Between a gutter and a panel's frame, antialiasing leaves a line or two
// blended from both - light gray beside a black frame - which shows as a
// thin light line along the panel in a dark reader. A cell loses up to
// MAX_BLEND_LINES such edge lines: a line goes when, on BLEND_LINE_FRACTION
// of its length, it is at least BLEND_STEP closer to the gutter color than
// the line just inside it. A panel whose own light background reaches its
// edge has no such step there and keeps every line.
const MAX_BLEND_LINES = 2;
const BLEND_STEP = 40;
const BLEND_LINE_FRACTION = 0.75;

function trimBlendLines(r: Raster, cell: Box, gutter: RGB): Box {
    let left = cell.left;
    let top = cell.top;
    let right = cell.left + cell.width;
    let bottom = cell.top + cell.height;
    const isBlend = (column: boolean, pos: number, inner: number) => {
        const from = column ? top : left;
        const to = column ? bottom : right;
        let count = 0;
        for (let i = from; i < to; i++) {
            const at = (q: number) => column ? i * r.width + q : q * r.width + i;
            if (distanceAt(r, at(pos), gutter) <= distanceAt(r, at(inner), gutter) - BLEND_STEP) count++;
        }
        return to > from && count >= (to - from) * BLEND_LINE_FRACTION;
    };
    for (let k = 0; k < MAX_BLEND_LINES && right - left > 2 && isBlend(true, left, left + 1); k++) left++;
    for (let k = 0; k < MAX_BLEND_LINES && right - left > 2 && isBlend(true, right - 1, right - 2); k++) right--;
    for (let k = 0; k < MAX_BLEND_LINES && bottom - top > 2 && isBlend(false, top, top + 1); k++) top++;
    for (let k = 0; k < MAX_BLEND_LINES && bottom - top > 2 && isBlend(false, bottom - 1, bottom - 2); k++) bottom--;
    return { left, top, width: right - left, height: bottom - top };
}

// ---------------------------------------------------------------------------
// 4. Speech bubbles across gutters
// ---------------------------------------------------------------------------

// A speech bubble is a closed area of light color (its inside) holding
// lettering - at least BUBBLE_MIN_LETTERS enclosed darker islands, each at
// most BUBBLE_MAX_LETTER and together at least BUBBLE_MIN_LETTERING of
// its area - at least BUBBLE_MIN_WIDTH_PX x BUBBLE_MIN_HEIGHT_PX, at most
// BUBBLE_MAX_AREA of the page and never touching the image edge (a
// gutter or an open background spreads further). Its shape is the inside
// with its lettering; with its outline (BUBBLE_MARGIN_PX around the shape)
// it may cross a gutter without blocking it (isCleanLine).
const BUBBLE_MIN_LIGHTNESS = 200;
const BUBBLE_TOLERANCE = 36;
const BUBBLE_MIN_WIDTH_PX = 40;
const BUBBLE_MIN_HEIGHT_PX = 20;
const BUBBLE_MAX_AREA = 0.05;
const BUBBLE_MIN_LETTERING = 0.02;
const BUBBLE_MIN_LETTERS = 8;
const BUBBLE_MAX_LETTER = 0.03;
const BUBBLE_MARGIN_PX = 6;
// The outline itself: this close to the shape. Further out in the margin,
// pixels belong to whatever the bubble overlaps.
const BUBBLE_OUTLINE_PX = 3;

interface Bubble {
    // The shape with its margin, as a box and per pixel (box-relative).
    box: Box;
    outline: Uint8Array;
    // The shape itself (inside and lettering), box-relative.
    shape: Uint8Array;
    // Distance from the shape (0 inside it, 255 beyond the margin).
    distance: Uint8Array;
}

function findBubbles(r: Raster): void {
    const { width, height } = r;
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    const maxArea = width * height * BUBBLE_MAX_AREA;
    const isLight = (p: number) => {
        const c = pixelAt(r, p);
        return Math.min(c.r, c.g, c.b) >= BUBBLE_MIN_LIGHTNESS;
    };
    for (let seed = 0; seed < width * height; seed++) {
        if (visited[seed] || !isLight(seed)) continue;
        // The light area around `seed`, 4-connected, in one color.
        const color = pixelAt(r, seed);
        let head = 0;
        let tail = 0;
        let closed = true;
        let left = width, top = height, right = -1, bottom = -1;
        visited[seed] = 1;
        queue[tail++] = seed;
        while (head < tail) {
            const p = queue[head++];
            const x = p % width;
            const y = (p / width) | 0;
            if (x === 0 || y === 0 || x === width - 1 || y === height - 1) closed = false;
            if (x < left) left = x;
            if (x > right) right = x;
            if (y < top) top = y;
            if (y > bottom) bottom = y;
            for (const n of [p - 1, p + 1, p - width, p + width]) {
                if (n < 0 || n >= width * height || visited[n]) continue;
                if ((n === p - 1 && x === 0) || (n === p + 1 && x === width - 1)) continue;
                if (distanceAt(r, n, color) > BUBBLE_TOLERANCE) continue;
                visited[n] = 1;
                queue[tail++] = n;
            }
        }
        const area = tail;
        if (!closed || area > maxArea) continue;
        const w = right - left + 1;
        const h = bottom - top + 1;
        if (w < BUBBLE_MIN_WIDTH_PX || h < BUBBLE_MIN_HEIGHT_PX) continue;

        // The shape: the area plus what it encloses - everything in its box
        // not reachable from the box's edge without crossing it.
        const inside = new Uint8Array(w * h);
        for (let i = 0; i < tail; i++) {
            const p = queue[i];
            inside[(((p / width) | 0) - top) * w + (p % width) - left] = 1;
        }
        const outside = new Uint8Array(w * h);
        const stack: number[] = [];
        const push = (i: number) => { if (!outside[i] && !inside[i]) { outside[i] = 1; stack.push(i); } };
        for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
        for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
        while (stack.length) {
            const i = stack.pop()!;
            const x = i % w;
            const y = (i / w) | 0;
            if (x > 0) push(i - 1);
            if (x < w - 1) push(i + 1);
            if (y > 0) push(i - w);
            if (y < h - 1) push(i + w);
        }
        // Lettering: enclosed islands, many and small each - a face's eyes
        // and mouth are few.
        let lettering = 0;
        let letters = 0;
        const seen = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            if (outside[i] || inside[i] || seen[i]) continue;
            let size = 0;
            const island = [i];
            seen[i] = 1;
            while (island.length) {
                const j = island.pop()!;
                size++;
                const x = j % w;
                const y = (j / w) | 0;
                for (const n of [x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1, y > 0 ? j - w : -1, y < h - 1 ? j + w : -1]) {
                    if (n >= 0 && !seen[n] && !outside[n] && !inside[n]) { seen[n] = 1; island.push(n); }
                }
            }
            lettering += size;
            if (size <= area * BUBBLE_MAX_LETTER) letters++;
        }
        if (lettering < area * BUBBLE_MIN_LETTERING || letters < BUBBLE_MIN_LETTERS) continue;

        const m = BUBBLE_MARGIN_PX;
        const box: Box = { left: Math.max(0, left - m), top: Math.max(0, top - m), width: 0, height: 0 };
        box.width = Math.min(width, right + 1 + m) - box.left;
        box.height = Math.min(height, bottom + 1 + m) - box.top;
        const shape = new Uint8Array(box.width * box.height);
        const outline = new Uint8Array(box.width * box.height);
        const distance = new Uint8Array(box.width * box.height).fill(255);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (outside[y * w + x]) continue;
                const sx = x + left - box.left;
                const sy = y + top - box.top;
                shape[sy * box.width + sx] = 1;
                for (let dy = -m; dy <= m; dy++) {
                    for (let dx = -m; dx <= m; dx++) {
                        const ox = sx + dx;
                        const oy = sy + dy;
                        if (ox >= 0 && oy >= 0 && ox < box.width && oy < box.height) {
                            const at = oy * box.width + ox;
                            outline[at] = 1;
                            distance[at] = Math.min(distance[at], Math.max(Math.abs(dx), Math.abs(dy)));
                        }
                    }
                }
            }
        }
        for (let y = 0; y < box.height; y++) {
            for (let x = 0; x < box.width; x++) {
                if (outline[y * box.width + x]) r.bubbleMask[(box.top + y) * width + box.left + x] = 1;
            }
        }
        r.bubbles.push({ box, outline, shape, distance });
    }
}

// The gutter color as the page actually has it: the median of the pixels
// near `color`, sampled - JPEG gutters are rarely exactly white.
function measuredColor(r: Raster, color: RGB): RGB {
    const rs: number[] = [], gs: number[] = [], bs: number[] = [];
    for (let p = 0; p < r.width * r.height; p += 7) {
        if (distanceAt(r, p, color) > GUTTER_TOLERANCE) continue;
        const c = pixelAt(r, p);
        rs.push(c.r); gs.push(c.g); bs.push(c.b);
    }
    if (!rs.length) return color;
    const median = (v: number[]) => v.sort((a, b) => a - b)[v.length >> 1];
    return { r: median(rs), g: median(gs), b: median(bs) };
}

// A panel crop. Where it grew to take in a speech bubble crossing its
// edge, the rest of the added strip is painted (`paint`: per crop pixel,
// whether to replace it and with which color).
export interface PanelCrop extends Box {
    paint?: { mask: Uint8Array; rgb: Uint8Array };
}

// A bubble whose shape reaches out of the cell holding most of it belongs
// to that cell, whose crop grows to take in the bubble with its outline. In
// the added strip, pixels beyond the outline (BUBBLE_OUTLINE_PX from the
// shape) are painted in the gutter color; the outline is redrawn between
// its own color and the gutter color by each pixel's darkness, so no
// fringe of the neighboring panel's colors stays around the bubble.
function withBubbles(r: Raster, fitted: (Box & { cell: Box })[], gutter: RGB): PanelCrop[] {
    const cells = fitted.map(f => f.cell);
    const crops: { cell: Box; crop: Box; bubbles: Bubble[] }[] = fitted.map(({ cell, ...crop }) => ({ cell: crop, crop: { ...crop }, bubbles: [] }));
    const inBox = (b: Box, x: number, y: number) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height;
    for (const bubble of r.bubbles) {
        const counts = cells.map(() => 0);
        let outsideOwner = false;
        for (let y = 0; y < bubble.box.height; y++) {
            for (let x = 0; x < bubble.box.width; x++) {
                if (!bubble.shape[y * bubble.box.width + x]) continue;
                const i = cells.findIndex(c => inBox(c, bubble.box.left + x, bubble.box.top + y));
                if (i >= 0) counts[i]++;
            }
        }
        const owner = counts.indexOf(Math.max(...counts));
        if (owner < 0 || counts[owner] === 0) continue;
        const cell = cells[owner];
        for (let y = 0; y < bubble.box.height && !outsideOwner; y++) {
            for (let x = 0; x < bubble.box.width; x++) {
                if (bubble.shape[y * bubble.box.width + x] && !inBox(cell, bubble.box.left + x, bubble.box.top + y)) {
                    outsideOwner = true;
                    break;
                }
            }
        }
        if (!outsideOwner) continue;
        const entry = crops[owner];
        const c = entry.crop;
        const left = Math.min(c.left, bubble.box.left);
        const top = Math.min(c.top, bubble.box.top);
        entry.crop = {
            left,
            top,
            width: Math.max(c.left + c.width, bubble.box.left + bubble.box.width) - left,
            height: Math.max(c.top + c.height, bubble.box.top + bubble.box.height) - top
        };
        entry.bubbles.push(bubble);
    }

    const lum = (c: RGB) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
    const gutterLum = lum(gutter);
    return crops.map(({ cell, crop, bubbles }) => {
        if (!bubbles.length) return cell;
        const mask = new Uint8Array(crop.width * crop.height);
        const rgb = new Uint8Array(crop.width * crop.height * 3);
        // The bubbles' outline color: the darkest pixels right around their
        // shapes.
        let darkest: RGB = { r: 0, g: 0, b: 0 };
        let darkestLum = 256;
        for (const b of bubbles) {
            for (let i = 0; i < b.outline.length; i++) {
                if (b.shape[i] || b.distance[i] > BUBBLE_OUTLINE_PX) continue;
                const c = pixelAt(r, (b.box.top + ((i / b.box.width) | 0)) * r.width + b.box.left + (i % b.box.width));
                if (lum(c) < darkestLum) { darkestLum = lum(c); darkest = c; }
            }
        }
        for (let y = crop.top; y < crop.top + crop.height; y++) {
            for (let x = crop.left; x < crop.left + crop.width; x++) {
                if (inBox(cell, x, y)) continue;
                const at = (y - crop.top) * crop.width + (x - crop.left);
                let shape = false;
                let ring = false;
                for (const b of bubbles) {
                    if (!inBox(b.box, x, y)) continue;
                    const i = (y - b.box.top) * b.box.width + (x - b.box.left);
                    if (b.shape[i]) shape = true;
                    else if (b.distance[i] <= BUBBLE_OUTLINE_PX) ring = true;
                }
                if (shape) continue;
                let color = gutter;
                if (ring) {
                    // Outline pixels keep their darkness, blended toward the
                    // gutter color instead of the neighbor's colors.
                    const l = lum(pixelAt(r, y * r.width + x));
                    const a = Math.max(0, Math.min(1, (gutterLum - l) / Math.max(1, gutterLum - darkestLum)));
                    color = {
                        r: Math.round(a * darkest.r + (1 - a) * gutter.r),
                        g: Math.round(a * darkest.g + (1 - a) * gutter.g),
                        b: Math.round(a * darkest.b + (1 - a) * gutter.b)
                    };
                }
                mask[at] = 1;
                rgb[at * 3] = color.r;
                rgb[at * 3 + 1] = color.g;
                rgb[at * 3 + 2] = color.b;
            }
        }
        return { ...crop, paint: { mask, rgb } };
    });
}

// ---------------------------------------------------------------------------
// 5. Reading order
// ---------------------------------------------------------------------------

// Rows top to bottom, and within a row, columns left to right (right to
// left for manga), each column top to bottom. A row starts with the topmost
// panel left and takes in every panel that starts in the upper half of the
// row's span or has its center inside it - growing the span as panels join,
// so a tall panel pulls in the whole stack beside it. Within the row,
// panels overlapping horizontally by more than half the narrower one's
// width form a column: a stack beside a tall panel is read down before
// moving over. Also reorders stored panels when a comic's reading direction
// changes.
export function sortReadingOrder<T extends Box>(boxes: T[], direction: ReadingDirection = 'ltr'): T[] {
    const remaining = boxes.slice().sort((a, b) => a.top - b.top || a.left - b.left);
    const rows: T[][] = [];

    while (remaining.length) {
        const seed = remaining.shift()!;
        const row = [seed];
        let rowTop = seed.top;
        let rowBottom = seed.top + seed.height;
        let grew = true;
        while (grew) {
            grew = false;
            for (let i = 0; i < remaining.length; i++) {
                const b = remaining[i];
                const centerY = b.top + b.height / 2;
                const startsInUpperHalf = b.top < rowTop + (rowBottom - rowTop) / 2;
                if ((centerY >= rowTop && centerY <= rowBottom) || startsInUpperHalf) {
                    row.push(b);
                    remaining.splice(i, 1);
                    rowTop = Math.min(rowTop, b.top);
                    rowBottom = Math.max(rowBottom, b.top + b.height);
                    grew = true;
                    break;
                }
            }
        }

        const columns: T[][] = [];
        for (const b of row.slice().sort((x, y) => x.left - y.left)) {
            const column = columns.find(c => c.some(o => {
                const overlap = Math.min(o.left + o.width, b.left + b.width) - Math.max(o.left, b.left);
                return overlap > Math.min(o.width, b.width) / 2;
            }));
            if (column) column.push(b);
            else columns.push([b]);
        }
        columns.sort((x, y) => direction === 'rtl'
            ? Math.max(...y.map(b => b.left + b.width)) - Math.max(...x.map(b => b.left + b.width))
            : Math.min(...x.map(b => b.left)) - Math.min(...y.map(b => b.left)));
        for (const c of columns) c.sort((x, y) => x.top - y.top);
        rows.push(columns.flat());
    }
    return rows.flat();
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * The panels of a decoded page (raw pixels in, crops out), in reading
 * order; empty when the page is one whole panel. The margin color's
 * gutters come first; a second gutter color only counts where the margin
 * color doesn't divide the page. Takes raw pixels so tests need no image
 * codec.
 */
export function detectPanelBoxes(data: Buffer, width: number, height: number, channels: number, direction: ReadingDirection = 'ltr'): PanelCrop[] {
    const r: Raster = { data, width, height, channels, bubbles: [], bubbleMask: new Uint8Array(width * height) };
    findBubbles(r);
    const [margin, ...inner] = gutterColorSets(r);
    let best: { cells: Box[]; colors: GutterColors } = { cells: panelsWith(r, margin), colors: margin };
    // Only where the margin color doesn't divide the page: a frame around
    // gutters of another color. Of those, the one cutting the most panels.
    if (!best.cells.length) {
        for (const colors of inner) {
            const cells = panelsWith(r, colors);
            if (cells.length > best.cells.length) best = { cells, colors };
        }
    }
    if (!best.cells.length) return [];
    const gutter = measuredColor(r, best.colors.inside[0]);
    // Each crop fitted inside its cell; whether a bubble reaches out is
    // judged against the cell.
    const crops = best.cells.map(cell => ({ ...trimBlendLines(r, insetFromGutters(r, cell), gutter), cell }));
    return withBubbles(r, sortReadingOrder(crops, direction), gutter);
}

export interface PanelImage {
    path: string;
    box: Box;
}

/**
 * Splits a downloaded page image into per-panel image files alongside it.
 * Returns the panels in reading order, each with its box on the page -
 * kept so a comic's reading direction can be changed later without the
 * image. A page that isn't split is one panel: the original file,
 * unchanged, covering the whole page.
 */
export async function splitIntoPanels(imagePath: string, direction: ReadingDirection = 'ltr'): Promise<PanelImage[]> {
    const image = sharp(imagePath);
    const { width, height } = await image.metadata();
    if (!width || !height) return [{ path: imagePath, box: { left: 0, top: 0, width: width ?? 0, height: height ?? 0 } }];

    const { data, info } = await image.clone().raw().toBuffer({ resolveWithObject: true });

    const boxes = detectPanelBoxes(data, width, height, info.channels, direction);
    if (boxes.length <= 1) return [{ path: imagePath, box: { left: 0, top: 0, width, height } }];

    const dir = path.dirname(imagePath);
    const ext = path.extname(imagePath);
    const base = path.basename(imagePath, ext);

    const panels: PanelImage[] = [];
    for (let i = 0; i < boxes.length; i++) {
        const { paint, ...box } = boxes[i];
        if (!paint) {
            const outPath = path.join(dir, `${base}_panel${i + 1}${ext}`);
            await sharp(imagePath).extract(box).toFile(outPath);
            panels.push({ path: outPath, box });
            continue;
        }
        // Saved losslessly: a JPEG's blocks would ring along the paint.
        const outPath = path.join(dir, `${base}_panel${i + 1}.png`);
        const rgb = await sharp(imagePath).extract(box).removeAlpha().raw().toBuffer();
        for (let p = 0; p < paint.mask.length; p++) {
            if (!paint.mask[p]) continue;
            rgb[p * 3] = paint.rgb[p * 3];
            rgb[p * 3 + 1] = paint.rgb[p * 3 + 1];
            rgb[p * 3 + 2] = paint.rgb[p * 3 + 2];
        }
        await sharp(rgb, { raw: { width: box.width, height: box.height, channels: 3 } }).png().toFile(outPath);
        panels.push({ path: outPath, box });
    }

    fs.unlinkSync(imagePath);
    return panels;
}
