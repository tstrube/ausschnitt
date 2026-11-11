import { JSDOM } from 'jsdom';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Comic, Direction, Page, SelectorFingerprint } from '../types';
import * as db from '../db';
import { matchElementByFingerprint, resolveHref } from './matchSelector';
import { sortReadingOrder, splitIntoPanels } from './panelSplitter';
import { imagesDirForComic } from '../paths';
import { crawlFetch } from './http';

async function fetchDom(url: string): Promise<Document> {
    const response = await crawlFetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return new JSDOM(await response.text()).window.document;
}

function getSelectorByDirection(comic: Comic, direction: Direction): SelectorFingerprint | null {
    switch (direction) {
        case 'next': return comic.selector_next;
        case 'back': return comic.selector_back;
        case 'first': return comic.selector_first;
        case 'latest': return comic.selector_latest;
        default: throw new Error('Invalid direction');
    }
}

export async function resolveNavUrl(comic: Comic, direction: Direction, lastPage: Page): Promise<string | null> {
    const selector = getSelectorByDirection(comic, direction);
    if (!selector) {
        console.error(`Selector for direction "${direction}" not defined for comic "${comic.title}"`);
        return null;
    }

    const document = await fetchDom(lastPage.original_url);
    const navEl = matchElementByFingerprint(selector, document);
    if (!navEl) {
        console.error('Navigation element not found');
        return null;
    }

    const navUrl = resolveHref(navEl);
    if (!navUrl) {
        console.error('Navigation URL not found');
        return null;
    }

    // Nav links are almost always relative (e.g. "?comic=1234") - resolve
    // against the page they were found on so it's a fetchable absolute URL.
    const resolved = new URL(navUrl, lastPage.original_url);

    // A mismatched selector (e.g. matching a "friends" link in the footer
    // instead of the real nav) can point off-site, and every later step
    // would apply this comic's selectors to an unrelated site's markup.
    // Never leave the comic's own domain.
    const normalizeHost = (host: string) => host.toLowerCase().replace(/^www\./, '');
    const comicHost = normalizeHost(new URL(comic.url).hostname);
    if (normalizeHost(resolved.hostname) !== comicHost) {
        console.error(`Navigation link left the comic's site (${comicHost} -> ${resolved.hostname}); refusing to follow`);
        return null;
    }

    return resolved.href;
}

// The (absolute) src of the comic image on `url`, without downloading it -
// enough to tell whether a moving-target homepage is showing something new.
export async function getComicImageSrc(comic: Comic, url: string): Promise<string | null> {
    if (!comic.selector_image) return null;
    const document = await fetchDom(url);
    const imageEl = matchElementByFingerprint(comic.selector_image, document);
    const src = imageEl?.getAttribute('src');
    return src ? new URL(src, url).href : null;
}

// Whether `url` is the comic's own registered root/home URL, ignoring a
// trailing slash (sites link to their homepage both ways).
function normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '');
}

export function isComicHomeUrl(url: string, comicUrl: string): boolean {
    return normalizeUrl(url) === normalizeUrl(comicUrl);
}

function hashBytes(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function downloadImageBytes(imageUrl: string): Promise<Buffer | null> {
    try {
        const imageRes = await crawlFetch(imageUrl);
        if (!imageRes.ok) throw new Error(`HTTP ${imageRes.status} for ${imageUrl}`);
        return Buffer.from(await imageRes.arrayBuffer());
    } catch (err) {
        console.error('Failed to download image:', err);
        return null;
    }
}

function storeImageBytes(buffer: Buffer, imageUrl: string, comicId: number): string {
    const imageFilename = `${Date.now()}_${path.basename(new URL(imageUrl).pathname)}`;
    const comicImagesDir = imagesDirForComic(comicId);
    if (!fs.existsSync(comicImagesDir)) fs.mkdirSync(comicImagesDir, { recursive: true });
    const imagePath = path.join(comicImagesDir, imageFilename);
    fs.writeFileSync(imagePath, buffer);
    return imagePath;
}

async function downloadAndStoreImage(imageUrl: string, comicId: number): Promise<{ path: string; hash: string } | null> {
    const buffer = await downloadImageBytes(imageUrl);
    if (!buffer) return null;
    try {
        const imagePath = storeImageBytes(buffer, imageUrl, comicId);
        return { path: imagePath, hash: hashBytes(buffer) };
    } catch (err) {
        console.error('Failed to store image:', err);
        return null;
    }
}

// Finds the comic image on page `url` and downloads it into the comic's
// images folder.
async function downloadPageImage(url: string, comic: Comic): Promise<{ path: string; hash: string } | null> {
    if (!comic.selector_image) {
        console.error('Image selector not defined for this comic');
        return null;
    }

    const document = await fetchDom(url);
    const imageEl = matchElementByFingerprint(comic.selector_image, document);

    if (!imageEl) {
        console.error('Image element not found');
        return null;
    }

    const imageSrc = imageEl.getAttribute('src');
    if (!imageSrc) {
        console.error('Image URL not found');
        return null;
    }
    return downloadAndStoreImage(new URL(imageSrc, url).href, comic.id);
}

// Requests for the same page that arrive while it's still being fetched
// (scroll loading both directions, a nav click during a load, two devices)
// share the one fetch, so a URL is never stored twice.
const inFlightPages = new Map<string, Promise<Page | null>>();

export function fetchAndStorePage(
    url: string,
    comic: Comic,
    direction: Direction,
    lastPageId: number | null = null
): Promise<Page | null> {
    const key = `${comic.id}\n${url}`;
    const pending = inFlightPages.get(key);
    if (pending) return pending;
    const promise = fetchAndStorePageOnce(url, comic, direction, lastPageId)
        .finally(() => inFlightPages.delete(key));
    inFlightPages.set(key, promise);
    return promise;
}

async function fetchAndStorePageOnce(
    url: string,
    comic: Comic,
    direction: Direction,
    lastPageId: number | null
): Promise<Page | null> {
    try {
        const existingPage = db.getPageByUrl(comic.id, url);
        if (existingPage) return existingPage;

        const downloaded = await downloadPageImage(url, comic);
        if (!downloaded) return null;

        // Split before inserting anything: the page row, its panels and the
        // link are then written together with no await in between, so no
        // other request can ever find this page without its panels.
        const panels = await splitIntoPanels(downloaded.path, comic.reading_direction);

        // Backstop for anything the in-flight map can't see (e.g. the same
        // URL reached through checkHomepageForNewPage meanwhile).
        const storedMeanwhile = db.getPageByUrl(comic.id, url);
        if (storedMeanwhile) {
            for (const panel of panels) {
                try { fs.unlinkSync(panel.path); } catch {}
            }
            return storedMeanwhile;
        }

        const newPageId = db.insertPage(comic.id, url, direction, lastPageId, downloaded.hash);
        panels.forEach((panel, index) => {
            db.insertPanel({ page_id: newPageId, panel_number: index, image_path: panel.path, box: panel.box });
        });

        if (newPageId && lastPageId) {
            db.setPageLinkVerified(lastPageId, newPageId, direction);
        }

        return db.getPage(newPageId);
    } catch (err) {
        console.error('Error fetching or storing page:', err);
        return null;
    }
}

// The permalink one step "back" from `document` (fetched from `documentUrl`).
function findBackUrl(comic: Comic, document: Document, documentUrl: string): string | null {
    if (!comic.selector_back) return null;
    const backEl = matchElementByFingerprint(comic.selector_back, document);
    const backHref = backEl ? resolveHref(backEl) : null;
    return backHref ? new URL(backHref, documentUrl).href : null;
}

/**
 * A comic's homepage always shows whatever's current, so it never has a
 * "next" link relative to itself. When a crawl's tip is anchored there
 * (the site's Next from its newest strip pointed at the bare homepage), a
 * new strip is detected by content instead: re-fetch the homepage and
 * compare its image with the stored `image_hash`. A `fromPage` without a
 * hash can't be compared, so its homepage image counts as new.
 *
 * If more than one strip was published since `fromPage`, storing only the
 * homepage's snapshot would skip the ones in between. So this first walks
 * back from the homepage via the "back" selector until it reaches a stored
 * page (or runs out), crawls those permalinks forward in order through
 * fetchAndStorePage, then appends the homepage snapshot after them.
 */
export async function checkHomepageForNewPage(comic: Comic, fromPage: Page): Promise<Page | null> {
    if (!comic.selector_image) return null;

    const homeDocument = await fetchDom(comic.url);
    const imageEl = matchElementByFingerprint(comic.selector_image, homeDocument);
    if (!imageEl) return null;

    const imageSrc = imageEl.getAttribute('src');
    if (!imageSrc) return null;
    const latestImageUrl = new URL(imageSrc, comic.url).href;

    const latestBuffer = await downloadImageBytes(latestImageUrl);
    if (!latestBuffer) return null;
    const latestHash = hashBytes(latestBuffer);

    if (fromPage.image_hash && latestHash === fromPage.image_hash) {
        return null; // same image still showing at home - nothing new yet
    }

    // Stops at a stored page, or after a cap in case the site's "back"
    // links cycle.
    const skippedUrls: string[] = [];
    let walkUrl = comic.url;
    let walkDocument: Document | null = homeDocument;
    for (let i = 0; i < 50 && walkDocument; i++) {
        const backUrl = findBackUrl(comic, walkDocument, walkUrl);
        if (!backUrl || isComicHomeUrl(backUrl, comic.url) || db.getPageByUrl(comic.id, backUrl)) {
            break;
        }
        skippedUrls.unshift(backUrl);
        walkUrl = backUrl;
        walkDocument = await fetchDom(backUrl);
    }

    let cursor = fromPage;
    for (const url of skippedUrls) {
        const inserted = await fetchAndStorePage(url, comic, 'next', cursor.id);
        if (!inserted) break;
        cursor = inserted;
    }

    let imagePath: string;
    try {
        imagePath = storeImageBytes(latestBuffer, latestImageUrl, comic.id);
    } catch (err) {
        console.error('Failed to store image:', err);
        return null;
    }

    // Split first, as in fetchAndStorePageOnce - the page never exists
    // without its panels.
    const panels = await splitIntoPanels(imagePath, comic.reading_direction);
    const newPageId = db.insertPage(comic.id, comic.url, 'next', cursor.id, latestHash);
    panels.forEach((panel, index) => {
        db.insertPanel({ page_id: newPageId, panel_number: index, image_path: panel.path, box: panel.box });
    });

    db.setPageLinkVerified(cursor.id, newPageId, 'next');

    return db.getPage(newPageId);
}

// After an Ignore: once every subscriber ignores the page, its image files
// go (db.releasePageImages). A page stored under the comic's homepage URL
// keeps them - re-fetching that URL shows a newer strip, not this one.
export function releaseIfIgnoredByAll(comic: Comic, page: Page): void {
    if (isComicHomeUrl(page.original_url, comic.url)) return;
    if (db.isPageIgnoredByAllSubscribers(page.id)) db.releasePageImages(page.id);
}

// Brings back a released page's images: downloads the image again from the
// page's own URL and splits it onto its panel rows (db.setPanelImages).
// True once every panel has its image. One download per page at a time.
const inFlightRestores = new Map<number, Promise<boolean>>();

export function ensurePageImages(comic: Comic, page: Page): Promise<boolean> {
    if (db.getPanels(page.id).every(p => p.image_path)) return Promise.resolve(true);
    const pending = inFlightRestores.get(page.id);
    if (pending) return pending;
    const promise = restorePageImages(comic, page)
        .catch(err => {
            console.error('Failed to restore page images:', err);
            return false;
        })
        .finally(() => inFlightRestores.delete(page.id));
    inFlightRestores.set(page.id, promise);
    return promise;
}

async function restorePageImages(comic: Comic, page: Page): Promise<boolean> {
    if (isComicHomeUrl(page.original_url, comic.url)) return false;
    const downloaded = await downloadPageImage(page.original_url, comic);
    if (!downloaded) return false;
    db.setPanelImages(page.id, await splitIntoPanels(downloaded.path, comic.reading_direction));
    return true;
}

// Puts every stored page of a comic in its reading direction's panel
// order: panels with a stored box are renumbered; a page with a panel
// without one is released and split again in the new order on the next
// landing (ensurePageImages). The homepage snapshot is left alone - it
// can't be downloaded again.
export function applyReadingDirection(comic: Comic): void {
    for (const { page, panels } of db.getComicPagesWithPanels(comic.id)) {
        if (panels.length < 2) continue;
        if (panels.every(p => p.box_left !== null)) {
            const boxed = panels.map(p => ({ id: p.id, left: p.box_left!, top: p.box_top!, width: p.box_width!, height: p.box_height! }));
            const ordered = sortReadingOrder(boxed, comic.reading_direction) as typeof boxed;
            db.setPanelOrder(ordered.map(b => b.id));
        } else if (panels.some(p => p.image_path) && !isComicHomeUrl(page.original_url, comic.url)) {
            db.releasePageImages(page.id);
        }
    }
}
