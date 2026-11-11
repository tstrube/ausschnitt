import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectPanelBoxes, sortReadingOrder } from './panelSplitter';

// A raw RGB buffer for detectPanelBoxes: white background, grey rects.
function makeRawImage(width: number, height: number, rects: { x0: number; y0: number; x1: number; y1: number }[]): Buffer {
    const buffer = Buffer.alloc(width * height * 3, 255);
    for (const { x0, y0, x1, y1 } of rects) {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const idx = (y * width + x) * 3;
                buffer[idx] = 100;
                buffer[idx + 1] = 100;
                buffer[idx + 2] = 100;
            }
        }
    }
    return buffer;
}

// Like makeRawImage, with a grey shade per rect.
function makeRawImageWithColors(width: number, height: number, rects: { x0: number; y0: number; x1: number; y1: number; color: number }[]): Buffer {
    const buffer = Buffer.alloc(width * height * 3, 255);
    for (const { x0, y0, x1, y1, color } of rects) {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const idx = (y * width + x) * 3;
                buffer[idx] = color;
                buffer[idx + 1] = color;
                buffer[idx + 2] = color;
            }
        }
    }
    return buffer;
}

// Like makeRawImage, with a full RGB color per rect - for colors that share
// their luma.
function makeRawImageRGB(width: number, height: number, bg: [number, number, number], rects: { x0: number; y0: number; x1: number; y1: number; color: [number, number, number] }[]): Buffer {
    const buffer = Buffer.alloc(width * height * 3);
    for (let i = 0; i < width * height; i++) {
        buffer[i * 3] = bg[0];
        buffer[i * 3 + 1] = bg[1];
        buffer[i * 3 + 2] = bg[2];
    }
    for (const { x0, y0, x1, y1, color } of rects) {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const idx = (y * width + x) * 3;
                buffer[idx] = color[0];
                buffer[idx + 1] = color[1];
                buffer[idx + 2] = color[2];
            }
        }
    }
    return buffer;
}

test('splits two side-by-side panels separated by a clear, proportionate gutter', () => {
    // Content band is 60% of the image height (well under the 85% "probably
    // one full-page panel" cutoff), so column-splitting is attempted. Gutter
    // (40px) is well under GUTTER_TO_PANEL_RATIO of the 140px panels it
    // separates, so it isn't merged back as "disproportionate".
    const data = makeRawImage(400, 300, [
        { x0: 20, y0: 40, x1: 160, y1: 220 },
        { x0: 200, y0: 40, x1: 340, y1: 220 }
    ]);

    const boxes = detectPanelBoxes(data, 400, 300, 3);
    assert.equal(boxes.length, 2);
});

test('falls back to a single panel for one big near-full-height panel', () => {
    // Content spans 93% of the image height - the "single full panel,
    // don't try to column-split incidental internal whitespace" guard.
    const data = makeRawImage(400, 300, [
        { x0: 10, y0: 10, x1: 390, y1: 290 }
    ]);

    const boxes = detectPanelBoxes(data, 400, 300, 3);
    assert.deepEqual(boxes, []);
});

test('falls back to a single panel for a blank/uniform image', () => {
    const data = makeRawImage(200, 200, []);
    const boxes = detectPanelBoxes(data, 200, 200, 3);
    assert.deepEqual(boxes, []);
});

test('a background-colored patch inside a panel is no gutter', () => {
    // A background-colored "doorway" sits inside panel A, surrounded by
    // panel A's own content on every side (only a thin 5px content bridge
    // top and bottom) - it never reaches the page's actual background, so
    // border-reachability correctly reclassifies it as content rather than
    // as a divider - so a light-colored doorway inside a panel never splits
    // it in two.
    const width = 500, height = 300;
    const data = makeRawImage(width, height, [
        { x0: 20, y0: 40, x1: 220, y1: 220 },   // panel A
        { x0: 260, y0: 40, x1: 460, y1: 220 }   // panel B (real, proportionate gutter)
    ]);
    // Punch the enclosed background-colored "doorway" into panel A.
    for (let y = 45; y < 215; y++) {
        for (let x = 90; x < 110; x++) {
            const idx = (y * width + x) * 3;
            data[idx] = 255;
            data[idx + 1] = 255;
            data[idx + 2] = 255;
        }
    }

    const boxes = detectPanelBoxes(data, width, height, 3);
    assert.equal(boxes.length, 2);
});

test('splits an irregular grid: 2-panel top row, 1-panel bottom row', () => {
    const data = makeRawImage(400, 400, [
        // top row: two panels, ~45% of image height
        { x0: 20, y0: 20, x1: 180, y1: 180 },
        { x0: 220, y0: 20, x1: 380, y1: 180 },
        // bottom row: one wide panel, separated by a clear horizontal gutter
        { x0: 20, y0: 220, x1: 380, y1: 380 }
    ]);

    const boxes = detectPanelBoxes(data, 400, 400, 3);
    assert.equal(boxes.length, 3);
});

test('trusts a single margin-colored gap that actually reaches the image border, with no second occurrence needed', () => {
    // Two content bands separated by a real white gap (matching the page's
    // own margin color) on both sides of a thin black line drawn in the
    // middle of that gap - the black line doesn't match the margin color, so
    // it's just an incidental stray mark, not a divider in its own right,
    // but the white gap surrounding it still is one, and is directly
    // traceable to the page's own outer edge (spanning the full image
    // width, touching both the left and right edges). Under the old
    // row/column-projection design this needed a *second* interior line
    // before a lone divider would be trusted; border-reachability trusts a
    // single genuine one on its own merits. The small black-line fragment
    // itself gets discarded as a stray mark (well under MIN_PANEL_FRACTION),
    // leaving exactly the two real content bands.
    const data = makeRawImageWithColors(300, 300, [
        { x0: 10, y0: 10, x1: 290, y1: 140, color: 100 },
        { x0: 0, y0: 145, x1: 300, y1: 149, color: 0 },
        { x0: 10, y0: 154, x1: 290, y1: 290, color: 100 }
    ]);

    const boxes = detectPanelBoxes(data, 300, 300, 3);
    assert.equal(boxes.length, 2);
});

test('splits panels using color, not just luma, when a background and its content happen to share the same luma', () => {
    // Background is a reddish grey (200,100,100); the two panels are filled
    // with a greenish grey (100,151,100) chosen so both colors compute to
    // (almost) the same greyscale luma - a luma-only classifier would see
    // panel content as indistinguishable from background and never detect
    // a grid here at all. Real color distance between the two is large, so
    // a color-aware classifier still tells them apart correctly.
    const data = makeRawImageRGB(400, 300, [200, 100, 100], [
        { x0: 20, y0: 40, x1: 160, y1: 220, color: [100, 151, 100] },
        { x0: 200, y0: 40, x1: 340, y1: 220, color: [100, 151, 100] }
    ]);

    const boxes = detectPanelBoxes(data, 400, 300, 3);
    assert.equal(boxes.length, 2);
});

test('splits panels that run flush to the left/right image edges, with margin only top and bottom', () => {
    // Two stacked panels with zero side margin (x0=0, x1=width - flush to
    // both edges for their whole height) and a real white gutter only
    // between/above/below them. A mode-vote over the whole border perimeter
    // would pick the panels' own edge-flush background instead of the white
    // margin (two full-height sides of content-colored border pixels outvote
    // the thin top/bottom margin), the gutters would then match nothing, and
    // the page would fall back to one panel. Only the four corners are reliably true
    // margin regardless of which sides run edge-to-edge - see
    // estimateMarginColor's doc comment.
    const data = makeRawImage(400, 600, [
        { x0: 0, y0: 20, x1: 400, y1: 290 },
        { x0: 0, y0: 310, x1: 400, y1: 580 }
    ]);

    const boxes = detectPanelBoxes(data, 400, 600, 3);
    assert.equal(boxes.length, 2);
});

test('does not fragment a panel whose own background is a tiled wall pattern with grout-colored lines', () => {
    // Three stacked panels with real white gutters between them. The middle
    // panel's own background is a tiled "wall" - repeating flat-grey grout
    // lines, individually long and thin enough to shape-qualify as a
    // candidate divider line (a character in front of a grey-tiled wall).
    // Read as dividers, they'd split the panel and separate its speech
    // bubbles from the characters. A divider must match the page's own
    // background color, full stop - the grout is a different, unrelated
    // color, so it's just shape-qualifying content, never a candidate
    // divider, regardless of how much of it there is.
    const width = 400, height = 600;
    const buffer = Buffer.alloc(width * height * 3, 255);
    const fill = (x0: number, y0: number, x1: number, y1: number, color: number) => {
        for (let y = y0; y < y1; y++) {
            for (let x = x0; x < x1; x++) {
                const idx = (y * width + x) * 3;
                buffer[idx] = color; buffer[idx + 1] = color; buffer[idx + 2] = color;
            }
        }
    };
    fill(20, 20, 380, 180, 100); // panel 1
    fill(20, 220, 380, 380, 100); // panel 2 base fill
    for (let y = 220; y < 380; y += 20) fill(20, y, 380, y + 4, 150); // horizontal grout lines
    for (let x = 20; x < 380; x += 40) fill(x, 220, x + 4, 380, 150); // vertical grout lines
    fill(20, 420, 380, 580, 100); // panel 3

    const boxes = detectPanelBoxes(buffer, width, height, 3);
    assert.equal(boxes.length, 3);
});

test('reading order: a stacked pair of panels next to a tall panel sorts top-to-bottom, not by insertion order', () => {
    // One tall panel on the left, two shorter panels stacked on its right.
    // The row-banding step in sortReadingOrder groups all three into one
    // "row" (the tall panel's height spans both), then sorts by `left` - the
    // two stacked panels share the same `left`, so their order must come
    // from `top`, not from insertion order.
    const width = 500, height = 460;
    const data = makeRawImageRGB(width, height, [255, 255, 255], [
        { x0: 20, y0: 20, x1: 220, y1: 440, color: [80, 80, 80] }, // tall left panel
        { x0: 260, y0: 20, x1: 480, y1: 210, color: [120, 60, 60] }, // top-right panel
        { x0: 260, y0: 250, x1: 480, y1: 440, color: [60, 60, 120] } // bottom-right panel
    ]);

    const boxes = detectPanelBoxes(data, width, height, 3);
    assert.equal(boxes.length, 3);

    const colorAt = (x: number, y: number) => {
        const idx = (y * width + x) * 3;
        return [data[idx], data[idx + 1], data[idx + 2]];
    };
    const colors = boxes.map(b => colorAt(b.left + 1, b.top + 1));
    assert.deepEqual(colors, [[80, 80, 80], [120, 60, 60], [60, 60, 120]]);
});

test('does not split a panel along thin margin-colored lines drawn inside it (door-frame edge lines)', () => {
    // Black page, black 20px gutter, two grey panels. Inside the left one,
    // two 1px black lines run from its top edge to its bottom edge, 6px
    // apart - a door frame's outlines, touching the gutters above and
    // below. The sliver between them is too small to be a panel on its
    // own; the lines must not be treated as a gutter either.
    const grey: [number, number, number] = [120, 120, 120];
    const black: [number, number, number] = [0, 0, 0];
    const data = makeRawImageRGB(400, 300, black, [
        { x0: 10, y0: 10, x1: 190, y1: 290, color: grey },
        { x0: 210, y0: 10, x1: 390, y1: 290, color: grey },
        { x0: 90, y0: 10, x1: 91, y1: 290, color: black },
        { x0: 96, y0: 10, x1: 97, y1: 290, color: black }
    ]);

    const boxes = detectPanelBoxes(data, 400, 300, 3);
    assert.equal(boxes.length, 2);
    assert.ok(boxes[0].left <= 12 && boxes[0].left + boxes[0].width >= 188, 'left panel keeps its full width');
});

test('keeps a caption that sits only a thin gap above a panel out of that panel', () => {
    // White page; a short title line 2px above the first panel. Too thin a
    // gap to be a gutter, but the caption still isn't part of the panel.
    const data = makeRawImage(400, 300, [
        { x0: 10, y0: 4, x1: 130, y1: 16 },
        { x0: 10, y0: 18, x1: 390, y1: 150 },
        { x0: 10, y0: 160, x1: 390, y1: 290 }
    ]);

    const boxes = detectPanelBoxes(data, 400, 300, 3);
    assert.equal(boxes.length, 2);
    assert.ok(boxes[0].top >= 16, `first panel starts below the caption (top=${boxes[0].top})`);
});

test('panels end exactly where their gutters start, off any sampling grid', () => {
    // Odd offsets: with SAMPLE_STRIDE 2 the grid alone put every edge a
    // pixel off (border column cut on the left/top, a white gutter line
    // kept on the right/bottom - a visible white line in dark mode).
    const data = makeRawImage(401, 301, [
        { x0: 21, y0: 41, x1: 161, y1: 221 },
        { x0: 201, y0: 41, x1: 341, y1: 221 }
    ]);

    const boxes = detectPanelBoxes(data, 401, 301, 3);
    assert.deepEqual(boxes, [
        { left: 22, top: 42, width: 138, height: 178 },
        { left: 202, top: 42, width: 138, height: 178 }
    ]);
});

test('a panel loses the antialias line between its gutter and its frame', () => {
    // A 1px light-gray line between the white gutter and each panel's
    // black frame would show as a light line in a dark reader.
    const rects = [];
    for (const [x0, x1] of [[20, 160], [200, 340]]) {
        rects.push({ x0: x0 - 1, y0: 39, x1: x1 + 1, y1: 221, color: 180 });
        rects.push({ x0, y0: 40, x1, y1: 220, color: 0 });
    }
    const data = makeRawImageWithColors(400, 300, rects);

    const boxes = detectPanelBoxes(data, 400, 300, 3);
    assert.deepEqual(boxes, [
        { left: 20, top: 40, width: 140, height: 180 },
        { left: 200, top: 40, width: 140, height: 180 }
    ]);
});

test('a panel keeps its own frame', () => {
    // Black frame straight onto white gutter, no antialiasing: the frame
    // line is nowhere near the gutter color and no lighter than inside.
    const data = makeRawImageWithColors(400, 300, [
        { x0: 20, y0: 40, x1: 160, y1: 220, color: 0 },
        { x0: 22, y0: 42, x1: 158, y1: 218, color: 120 },
        { x0: 200, y0: 40, x1: 340, y1: 220, color: 0 },
        { x0: 202, y0: 42, x1: 338, y1: 218, color: 120 }
    ]);

    const boxes = detectPanelBoxes(data, 400, 300, 3);
    assert.deepEqual(boxes, [
        { left: 21, top: 41, width: 138, height: 178 },
        { left: 201, top: 41, width: 138, height: 178 }
    ]);
});

// A black title bar with white "text" fused to panel 1's black frame - no
// gutter between them.
function pageWithTitleBar(withTitle: boolean): Buffer {
    const width = 400, height = 400;
    const rects: { x0: number; y0: number; x1: number; y1: number; color: number }[] = [];
    for (const [y0, y1] of [[20, 190], [210, 380]]) {
        rects.push({ x0: 20, y0, x1: 380, y1, color: 0 });          // frame
        rects.push({ x0: 23, y0: y0 + 3, x1: 377, y1: y1 - 3, color: 150 }); // art
    }
    if (withTitle) {
        rects.push({ x0: 20, y0: 6, x1: 380, y1: 20, color: 0 });   // bar
        for (let x = 30; x < 200; x += 6) rects.push({ x0: x, y0: 9, x1: x + 3, y1: 16, color: 255 }); // text
    }
    return makeRawImageWithColors(width, height, rects);
}

test('a title bar fused to the top panel\'s frame, with no gutter between them, stays with it', () => {
    const boxes = detectPanelBoxes(pageWithTitleBar(true), 400, 400, 3);
    assert.deepEqual(boxes, [
        { left: 21, top: 7, width: 358, height: 182 },
        { left: 21, top: 211, width: 358, height: 168 }
    ]);
});

test('leaves a plain framed panel without a title bar untouched', () => {
    const boxes = detectPanelBoxes(pageWithTitleBar(false), 400, 400, 3);
    assert.deepEqual(boxes, [
        { left: 21, top: 21, width: 358, height: 168 },
        { left: 21, top: 211, width: 358, height: 168 }
    ]);
});

test('footer text right against the last panel, with no gutter between them, stays with it', () => {
    // Black page, two light panels; white "text" in the background right
    // below the last panel, its letters touching the panel - no gutter and
    // no clean line between text and art.
    const width = 400, height = 420;
    const buffer = Buffer.alloc(width * height * 3, 0);
    const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buffer.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    };
    fill(20, 20, 380, 190, 170);
    fill(20, 210, 380, 380, 170);
    for (let x = 200; x < 370; x += 6) fill(x, 380, x + 3, 392, 255);

    const boxes = detectPanelBoxes(buffer, width, height, 3);
    assert.equal(boxes.length, 2);
    assert.deepEqual(boxes[1], { left: 21, top: 211, width: 358, height: 180 });
});

test('keeps a wide shape glued below the last panel on a black page - not lettering', () => {
    // Same page as the footer test, but one wide white shape instead of
    // thin letters, touching the panel: a bubble or other art, so the panel
    // keeps it.
    const width = 400, height = 420;
    const buffer = Buffer.alloc(width * height * 3, 0);
    const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buffer.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    };
    fill(20, 20, 380, 190, 170);
    fill(20, 210, 380, 380, 170);
    fill(150, 380, 260, 392, 255);

    const boxes = detectPanelBoxes(buffer, width, height, 3);
    assert.equal(boxes.length, 2);
    assert.deepEqual(boxes[1], { left: 21, top: 211, width: 358, height: 180 });
});

test('a 1px line along the image edge does not join the panels it touches', () => {
    // Black page, two stacked panels flush with the left edge, and a 1px
    // white line down the whole left edge crossing the gutter between them.
    const width = 400, height = 420;
    const buffer = Buffer.alloc(width * height * 3, 0);
    const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buffer.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    };
    fill(0, 20, 380, 190, 170);
    fill(0, 210, 380, 400, 170);
    fill(0, 0, 1, height, 255);

    const boxes = detectPanelBoxes(buffer, width, height, 3);
    assert.equal(boxes.length, 2);
    assert.deepEqual(boxes.map(b => [b.top, b.height]), [[21, 168], [211, 188]]);
});

test('a panel is not cut down to a sliver when a hairline joins its main part to a neighbor', () => {
    // Black page, two stacked panels. The top one has a black line drawn
    // down its full height at x=27 (cutting off a 27px slice), and a 1px
    // white line runs down the right image edge, joining both panels.
    const width = 400, height = 420;
    const buffer = Buffer.alloc(width * height * 3, 0);
    const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buffer.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    };
    fill(0, 20, 400, 190, 170);
    fill(27, 20, 29, 190, 0);
    fill(0, 210, 400, 400, 170);
    fill(399, 0, 400, height, 255);

    const boxes = detectPanelBoxes(buffer, width, height, 3);
    assert.equal(boxes.length, 2);
    assert.deepEqual(boxes.map(b => [b.left, b.width]), [[0, 400], [0, 400]]);
});

// A page framed in black - title bar on top, footer below, so every corner
// is black - with white gutters between panels that run flush to the
// left/right image edges. Each panel has a 2px black outline - where it
// meets the black frame it can't be told from the frame and is cropped
// with it; along the gutters and the image edge it stays.
function makeFramedPage(width: number, height: number, panels: { x0: number; y0: number; x1: number; y1: number; v: number }[]): Buffer {
    const buffer = Buffer.alloc(width * height * 3, 255);
    const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buffer.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    };
    fill(0, 0, width, 20, 0);
    fill(0, height - 20, width, height, 0);
    for (const p of panels) {
        fill(p.x0, p.y0, p.x1, p.y1, 0);
        fill(p.x0 + 2, p.y0 + 2, p.x1 - 2, p.y1 - 2, p.v);
    }
    return buffer;
}

test('splits a black-framed page along white gutters that run out to the image edge', () => {
    const width = 400, height = 580;
    const data = makeFramedPage(width, height, [
        { x0: 0, y0: 20, x1: 197, y1: 280, v: 120 },
        { x0: 203, y0: 20, x1: 400, y1: 280, v: 140 },
        { x0: 0, y0: 286, x1: 250, y1: 560, v: 160 },
        { x0: 256, y0: 286, x1: 400, y1: 560, v: 180 }
    ]);

    const boxes = detectPanelBoxes(data, width, height, 3);
    assert.deepEqual(boxes.map(b => [b.left, b.top, b.width, b.height]), [
        [0, 21, 196, 258], [204, 21, 196, 258], [0, 287, 249, 272], [257, 287, 143, 272]
    ]);
});

test('splits a black-framed page whose white gutters only reach the frame, not the image edge', () => {
    // One gutter from title bar to footer, staggered gutters on either side
    // of it - none reaches the image edge. The top-left panel's own white
    // background touches the frame too, but is no gutter.
    const width = 400, height = 580;
    const data = makeFramedPage(width, height, [
        { x0: 0, y0: 20, x1: 197, y1: 260, v: 255 },
        { x0: 0, y0: 266, x1: 197, y1: 560, v: 120 },
        { x0: 203, y0: 20, x1: 400, y1: 320, v: 140 },
        { x0: 203, y0: 326, x1: 400, y1: 560, v: 160 }
    ]);
    const fill = (x0: number, y0: number, x1: number, y1: number, v: number) => {
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) data.fill(v, (y * width + x) * 3, (y * width + x) * 3 + 3);
    };
    fill(40, 80, 150, 200, 90); // artwork on the white panel background

    const boxes = detectPanelBoxes(data, width, height, 3);
    assert.deepEqual(boxes.map(b => [b.left, b.top, b.width, b.height]), [
        [0, 21, 196, 238], [204, 21, 196, 298], [0, 267, 196, 292], [204, 327, 196, 232]
    ]);
});

// Fills a rect of a raw RGB buffer with one color.
function fillRGB(buffer: Buffer, width: number, x0: number, y0: number, x1: number, y1: number, c: [number, number, number]): void {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) buffer.set(c, (y * width + x) * 3);
}

test('splits along narrow inner gutters drawn in two near-identical tones, off the sampling grid', () => {
    // Black frame (title bar, footer), panels flush to the image edges, a
    // 2px black outline per panel, and 5px gutters: 1px of a light tone on
    // each side of 3px of a slightly darker one - never 4px of one exact
    // color - starting on odd pixels.
    const width = 400, height = 580;
    const light: [number, number, number] = [255, 239, 228];
    const mid: [number, number, number] = [247, 227, 219];
    const buffer = Buffer.alloc(width * height * 3, 0);
    fillRGB(buffer, width, 0, 287, width, 292, light);
    fillRGB(buffer, width, 0, 288, width, 291, mid);
    fillRGB(buffer, width, 197, 20, 202, 560, light);
    fillRGB(buffer, width, 198, 20, 201, 560, mid);
    for (const [x0, y0, x1, y1] of [[0, 20, 197, 287], [202, 20, 400, 287], [0, 292, 197, 560], [202, 292, 400, 560]]) {
        fillRGB(buffer, width, x0, y0, x1, y1, [0, 0, 0]);
        fillRGB(buffer, width, x0 + 2, y0 + 2, x1 - 2, y1 - 2, [120, 160, 200]);
    }

    const boxes = detectPanelBoxes(buffer, width, height, 3);
    assert.deepEqual(boxes.map(b => [b.left, b.top, b.width, b.height]), [
        [0, 21, 197, 266], [202, 21, 198, 266], [0, 292, 197, 267], [202, 292, 198, 267]
    ]);
});

test('a speech bubble blocking a row gutter in one column leaves the page whole', () => {
    // Black frame, white 5px gutters. A white bubble with a 2px black
    // outline in the bottom-left panel breaks through its frame and up into
    // the gutter, leaving 1px of gutter above it for 30px - too little to
    // cut. The right column's row gutter is clear, but its panels can't be
    // read in order with the left column's joined: no split at all.
    const width = 400, height = 580;
    const data = makeFramedPage(width, height, [
        { x0: 0, y0: 20, x1: 197, y1: 280, v: 120 },
        { x0: 203, y0: 20, x1: 400, y1: 280, v: 140 },
        { x0: 0, y0: 285, x1: 197, y1: 560, v: 160 },
        { x0: 203, y0: 285, x1: 400, y1: 560, v: 180 }
    ]);
    fillRGB(data, width, 60, 281, 90, 330, [0, 0, 0]);
    fillRGB(data, width, 62, 283, 88, 328, [255, 255, 255]);

    assert.deepEqual(detectPanelBoxes(data, width, height, 3), []);
});

test('keeps a panel whole when its bubble and figure float apart on a background in the margin color', () => {
    // Green page (so green is the margin) with white gutters between four
    // frameless green panels; in each, a bubble and a figure with green
    // between them.
    const width = 400, height = 560;
    const green: [number, number, number] = [67, 114, 68];
    const buffer = Buffer.alloc(width * height * 3);
    fillRGB(buffer, width, 0, 0, width, height, green);
    fillRGB(buffer, width, 0, 277, width, 283, [255, 255, 255]);
    fillRGB(buffer, width, 197, 0, 203, height, [255, 255, 255]);
    for (const [px, py] of [[0, 0], [203, 0], [0, 283], [203, 283]]) {
        fillRGB(buffer, width, px + 10, py + 10, px + 180, py + 110, [0, 0, 0]);
        fillRGB(buffer, width, px + 12, py + 12, px + 178, py + 108, [250, 250, 250]);
        for (let x = px + 30; x < px + 160; x += 8) fillRGB(buffer, width, x, py + 40, x + 4, py + 50, [0, 0, 0]);
        fillRGB(buffer, width, px + 70, py + 130, px + 170, py + 270, [120, 90, 60]);
    }

    const boxes = detectPanelBoxes(buffer, width, height, 3);
    assert.equal(boxes.length, 4, JSON.stringify(boxes));
});

test('a speech bubble crossing its panel frame into the gutter stays whole', () => {
    // Black-framed page, white gutters. The bottom-left panel's bubble
    // (outlined, with "text") reaches up through its frame and across most
    // of the gutter: the crop has to take it, not end at the frame.
    const width = 400, height = 580;
    const data = makeFramedPage(width, height, [
        { x0: 0, y0: 20, x1: 197, y1: 260, v: 120 },
        { x0: 203, y0: 20, x1: 400, y1: 260, v: 140 },
        { x0: 0, y0: 280, x1: 197, y1: 560, v: 160 },
        { x0: 203, y0: 280, x1: 400, y1: 560, v: 180 }
    ]);
    fillRGB(data, width, 40, 264, 160, 320, [0, 0, 0]);
    fillRGB(data, width, 42, 266, 158, 318, [255, 255, 255]);
    for (let x = 50; x < 150; x += 6) fillRGB(data, width, x, 270, x + 3, 278, [0, 0, 0]);

    const boxes = detectPanelBoxes(data, width, height, 3);
    assert.equal(boxes.length, 4);
    assert.ok(boxes[2].top <= 265, JSON.stringify(boxes[2]));
    assert.ok(boxes[0].top + boxes[0].height <= 264, JSON.stringify(boxes[0]));
});

test('reading order: stacked panels are read as a column, left to right or right to left', () => {
    // A wide panel on top; below it a stacked pair on the left beside a
    // tall panel on the right, the lower of the pair starting below the
    // pair's middle.
    const top = { left: 0, top: 0, width: 400, height: 200 };
    const upperLeft = { left: 0, top: 210, width: 195, height: 140 };
    const lowerLeft = { left: 0, top: 360, width: 195, height: 140 };
    const tallRight = { left: 205, top: 210, width: 195, height: 290 };
    const boxes = [tallRight, lowerLeft, top, upperLeft];

    assert.deepEqual(sortReadingOrder(boxes, 'ltr'), [top, upperLeft, lowerLeft, tallRight]);
    assert.deepEqual(sortReadingOrder(boxes, 'rtl'), [top, tallRight, upperLeft, lowerLeft]);
});

test('a gutter narrowed by a speech bubble still splits, lined up with the gutter beside it', () => {
    // White page, four frameless panels, 12px gutters. The bottom-right
    // panel's bubble reaches 9px up into the gutter above it, leaving 3px
    // clear - too thin on its own, but in line with the left column's.
    const width = 400, height = 580;
    const buffer = Buffer.alloc(width * height * 3, 255);
    fillRGB(buffer, width, 0, 20, 194, 280, [120, 160, 200]);
    fillRGB(buffer, width, 206, 20, 400, 280, [200, 120, 120]);
    fillRGB(buffer, width, 0, 292, 194, 560, [150, 200, 150]);
    fillRGB(buffer, width, 206, 292, 400, 560, [150, 200, 230]);
    fillRGB(buffer, width, 240, 283, 380, 340, [0, 0, 0]);
    fillRGB(buffer, width, 242, 285, 378, 338, [255, 255, 255]);
    for (let x = 250; x < 370; x += 6) fillRGB(buffer, width, x, 300, x + 3, 310, [0, 0, 0]);

    const boxes = detectPanelBoxes(buffer, width, height, 3);
    assert.equal(boxes.length, 4, JSON.stringify(boxes.map(b => [b.left, b.top, b.width, b.height])));
    // The bubble stays whole in the bottom-right panel.
    assert.ok(boxes[3].top <= 284, JSON.stringify([boxes[3].left, boxes[3].top]));
});

test('a speech bubble crossing a framed gutter still splits; its panel takes the bubble in, painted beside it', () => {
    // Black-framed page, white 6px gutters. The bottom-left panel's bubble
    // (outline, white inside, lettering) reaches up across the row gutter
    // into the panel above.
    const width = 400, height = 580;
    const data = makeFramedPage(width, height, [
        { x0: 0, y0: 20, x1: 197, y1: 280, v: 120 },
        { x0: 203, y0: 20, x1: 400, y1: 280, v: 140 },
        { x0: 0, y0: 286, x1: 197, y1: 560, v: 160 },
        { x0: 203, y0: 286, x1: 400, y1: 560, v: 180 }
    ]);
    fillRGB(data, width, 40, 262, 160, 330, [0, 0, 0]);
    fillRGB(data, width, 42, 264, 158, 328, [255, 255, 255]);
    for (let x = 50; x < 150; x += 7) fillRGB(data, width, x, 290, x + 3, 300, [0, 0, 0]);

    const boxes = detectPanelBoxes(data, width, height, 3);
    assert.equal(boxes.length, 4);
    const bottomLeft = boxes[2];
    assert.ok(bottomLeft.top <= 262, JSON.stringify([bottomLeft.left, bottomLeft.top]));
    assert.ok(bottomLeft.paint, 'the strip beside the bubble is painted');
    // Beside the bubble, above the panel, the paint is the gutter's white.
    const at = (5 + (270 - bottomLeft.top) * bottomLeft.width) * 3;
    assert.deepEqual([...bottomLeft.paint!.rgb.subarray(at, at + 3)], [255, 255, 255]);
    assert.equal(boxes[0].top + boxes[0].height <= 280, true);
});

test('lines of text on a white panel stay one panel', () => {
    // White page: gray panels above and below, between them a frameless
    // text panel - lines of "lettering" (thin strokes) with white gaps
    // between them as wide as gutters, each line taller than a panel's
    // minimum.
    const width = 400, height = 900;
    const buffer = Buffer.alloc(width * height * 3, 255);
    fillRGB(buffer, width, 20, 20, 380, 220, [120, 120, 120]);
    fillRGB(buffer, width, 20, 680, 380, 880, [140, 140, 140]);
    for (const y of [250, 350, 450, 550]) {
        // Dashes offset row to row, like letters: no straight gap down
        // through a line, no row dark enough to pass for a frame line.
        [10, 35, 60].forEach((dy, k) => {
            for (let x = 40 + k * 3; x < 360; x += 9) fillRGB(buffer, width, x, y + dy, x + 4, y + dy + 3, [0, 0, 0]);
        });
    }

    const boxes = detectPanelBoxes(buffer, width, height, 3);
    assert.equal(boxes.length, 3, JSON.stringify(boxes.map(b => [b.left, b.top, b.width, b.height])));
});
