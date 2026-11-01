import { Router, Request, Response } from 'express';
import * as db from '../db';
import path from 'path';
import { ReaderCache } from '../readerCache';
import { Panel, ReaderComic } from '../types';
import { IMAGES_DIR } from '../paths';
import sharp from 'sharp';

export const router = Router();

// The URL of a stored image under the /images static mount.
function imageUrlFor(imagePath: string): string {
    return `/images/${path.relative(IMAGES_DIR, imagePath).split(path.sep).join('/')}`;
}

// Panel image dimensions, so the scroll feed can give every <img> its
// final size before the image has loaded - a panel inserted above the
// viewport must never grow afterwards and push what's being read down.
// Read from the file header and cached by file path: panel files never
// change in place (images are served immutable).
const panelSizeCache = new Map<string, { width: number; height: number } | null>();
async function panelSize(panel: Panel): Promise<{ width: number; height: number } | null> {
    if (panelSizeCache.has(panel.image_path)) return panelSizeCache.get(panel.image_path)!;
    let size: { width: number; height: number } | null = null;
    try {
        const meta = await sharp(panel.image_path).metadata();
        if (meta.width && meta.height) size = { width: meta.width, height: meta.height };
    } catch {
        // Missing/unreadable file - the client just falls back to sizing
        // the image once it loads.
    }
    panelSizeCache.set(panel.image_path, size);
    return size;
}

async function scrollPanelsJson(panels: Panel[]) {
    return Promise.all(panels.map(async p => {
        const size = await panelSize(p);
        return {
            id: p.id,
            pageId: p.page_id,
            imageUrl: imageUrlFor(p.image_path),
            width: size?.width ?? null,
            height: size?.height ?? null
        };
    }));
}

// A comic that's never been read has no bookmark yet; reading it counts as
// following the bookmark, so progress auto-saves from the first Next on.
function isAtBookmark(comic: ReaderComic, panel: Panel): boolean {
    if (!comic.last_read_page) return true;
    return comic.last_read_page === panel.page_id && comic.last_read_panel === panel.id;
}

// "Save Resume Point" overwrites the live bookmark, which ordinary reading
// moves without creating a history checkpoint - so snapshot the position
// it replaces into history first (unless it's already the newest entry).
function snapshotLiveBookmarkIfReplacing(userId: number, comic: ReaderComic, newPageId: number, newPanelId: number): void {
    if (!comic.last_read_page || !comic.last_read_panel) return;
    if (comic.last_read_page === newPageId && comic.last_read_panel === newPanelId) return;

    const [mostRecent] = db.getRecentBookmarkHistory(userId, comic.id, 1);
    if (mostRecent && mostRecent.page_id === comic.last_read_page && mostRecent.panel_id === comic.last_read_panel) {
        return;
    }

    db.addBookmarkHistoryEntry(userId, comic.id, comic.last_read_page, comic.last_read_panel, 'auto');
}

// Whether a client that believes the live bookmark is `fromPanelId` is
// still following it - a compare-and-set against the DB, not ReaderCache's
// cursor, which is shared by every request for this (user, comic) and moved
// by getWindowAround mid-request.
function clientFollowsBookmark(comic: ReaderComic, fromPanelId: unknown): boolean {
    if (!comic.last_read_page) return true;
    const from = Number(fromPanelId);
    return Number.isInteger(from) && comic.last_read_panel === from;
}

// A client-supplied panel id, resolved and checked to belong to this comic.
function panelInComic(panelId: unknown, comicId: number): Panel | null {
    const id = Number(panelId);
    if (!Number.isInteger(id)) return null;
    const panel = db.getPanelById(id);
    if (!panel) return null;
    const page = db.getPage(panel.page_id);
    return page && page.comic_id === comicId ? panel : null;
}

// The JSON every in-reader navigation answers with.
function navResponse(userId: number, comic: ReaderComic, panel: Panel) {
    return {
        comic,
        panel,
        imageUrl: imageUrlFor(panel.image_path),
        atBookmark: isAtBookmark(comic, panel),
        bookmarkHistory: db.getRecentBookmarkHistory(userId, comic.id, db.MAX_BOOKMARK_HISTORY),
        bookmarks: db.getBookmarksForComic(userId, comic.id)
    };
}

type NavDirection = 'next' | 'back' | 'first' | 'latest' | 'page-first' | 'resume' | 'bookmark' | 'ignore';
const VALID_DIRECTIONS: NavDirection[] = ['next', 'back', 'first', 'latest', 'page-first', 'resume', 'bookmark', 'ignore'];

// Next/Back/page-first/ignore move the bookmark only while the client is
// at it, so normal reading auto-saves. After a First/Latest jump they're
// just browsing; only "bookmark" ("Save Resume Point") commits a new
// position. Resume re-syncs to the bookmark. First/Latest never move it -
// that's what makes them undoable.
const CONDITIONAL_BOOKMARK_DIRECTIONS: NavDirection[] = ['next', 'back', 'page-first', 'ignore'];
const ALWAYS_BOOKMARK_DIRECTIONS: NavDirection[] = ['resume', 'bookmark'];

// Panels the scroll feed loads on either side of the current position on
// the initial page load, and the most one /scroll-window request returns.
const SCROLL_WINDOW_SIZE = 6;
const SCROLL_WINDOW_MAX = 30;

router.get('/:id', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    if (isNaN(comicId)) {
        res.status(400).send('Invalid comic ID');
        return;
    }

    const readerCache = ReaderCache.getInstance(req.user!.id, comicId);
    const comic = await readerCache.getComic();
    if (!comic) {
        res.status(404).send('Comic not found');
        return;
    }
    db.touchComicCacheAccess(comic.id);

    let panel = readerCache.getCurrentPanel();
    if (!panel) {
        panel = await readerCache.getFirstPanel();
    }

    if (!panel) {
        res.status(404).send('No panels available for this comic yet. Make sure its selectors are configured.');
        return;
    }

    if (db.getEffectiveReadingMode(comic) === 'scroll') {
        const window = await readerCache.getWindowAround(panel.page_id, panel.id, SCROLL_WINDOW_SIZE, SCROLL_WINDOW_SIZE);
        if (window.length) readerCache.readAhead(window[window.length - 1].page_id);
        res.render('reader-scroll', {
            comic,
            panels: await scrollPanelsJson(window),
            anchorPanelId: panel.id,
            atBookmark: isAtBookmark(comic, panel),
            hideNav: db.getEffectiveHideScrollNav(comic),
            bookmarkHistory: db.getRecentBookmarkHistory(req.user!.id, comic.id, db.MAX_BOOKMARK_HISTORY),
            bookmarks: db.getBookmarksForComic(req.user!.id, comic.id)
        });
        return;
    }

    readerCache.readAhead(panel.page_id);
    res.render('reader', {
        comic,
        panel,
        imageUrl: imageUrlFor(panel.image_path),
        atBookmark: isAtBookmark(comic, panel),
        bookmarkHistory: db.getRecentBookmarkHistory(req.user!.id, comic.id, db.MAX_BOOKMARK_HISTORY),
        bookmarks: db.getBookmarksForComic(req.user!.id, comic.id)
    });
});

// Extends the scroll feed as the user nears a loaded edge: a fresh window
// around the anchor panel (the one the client has loaded closest to that
// edge), not an incremental diff.
router.get('/:id/scroll-window', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    if (isNaN(comicId)) {
        res.status(400).json({ error: 'Invalid comic ID' });
        return;
    }
    const before = Math.min(Math.max(Number(req.query.before) || 0, 0), SCROLL_WINDOW_MAX);
    const after = Math.min(Math.max(Number(req.query.after) || 0, 0), SCROLL_WINDOW_MAX);

    // Must belong to this comic - otherwise the walk would crawl another
    // comic's pages with this comic's selectors.
    const anchorPanel = panelInComic(req.query.anchor, comicId);
    if (!anchorPanel) {
        res.status(404).json({ error: 'Anchor panel not found' });
        return;
    }

    const readerCache = ReaderCache.getInstance(req.user!.id, comicId);
    const comic = await readerCache.getComic(true);
    if (!comic) {
        res.status(404).json({ error: 'Comic not found' });
        return;
    }

    const window = await readerCache.getWindowAround(anchorPanel.page_id, anchorPanel.id, before, after);
    if (window.length) readerCache.readAhead(window[window.length - 1].page_id);
    res.json({
        panels: await scrollPanelsJson(window)
    });
});

// Scroll mode's equivalent of Next/Back auto-save: the client reports the
// most visible panel plus `fromPanelId`, the panel it last knew to be the
// live bookmark (null once it has jumped away). Persists only while the
// client is following the bookmark, so scrolling after a jump never
// overwrites it. The client sends these one at a time and the
// compare-and-set is synchronous, so reports can't race. Also receives
// navigator.sendBeacon's flush on page hide.
router.post('/:id/scroll-position', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    if (isNaN(comicId)) {
        res.status(400).json({ error: 'Invalid comic ID' });
        return;
    }

    const comic = db.getReaderComic(req.user!.id, comicId);
    if (!comic) {
        res.status(404).json({ error: 'Comic not found' });
        return;
    }

    const panel = panelInComic(req.body?.panelId, comicId);
    if (!panel) {
        res.status(404).json({ error: 'Panel not found' });
        return;
    }

    const following = clientFollowsBookmark(comic, req.body?.fromPanelId);
    if (following) {
        db.updateLastRead(req.user!.id, comic.id, panel.page_id, panel.id);
    }

    // Keep the cache cursor in sync too, so a mode switch back to paged
    // picks up here.
    await ReaderCache.getInstance(req.user!.id, comicId).loadPanel(panel.page_id, panel.id);

    res.json({ atBookmark: following || isAtBookmark(comic, panel) });
});

router.post('/:id/nav/:direction', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    const direction = req.params.direction as NavDirection;
    if (isNaN(comicId)) {
        res.status(400).json({ error: 'Invalid comic ID' });
        return;
    }
    if (!VALID_DIRECTIONS.includes(direction)) {
        res.status(400).json({ error: 'Invalid navigation direction' });
        return;
    }

    const readerCache = ReaderCache.getInstance(req.user!.id, comicId);
    const comic = await readerCache.getComic();
    if (!comic) {
        res.status(404).json({ error: 'Comic not found' });
        return;
    }
    db.touchComicCacheAccess(comic.id);

    // Every nav moves from the panel the client is showing, never from the
    // server's cursor - that's shared by every device and tab of this user
    // and moves during feed loads.
    const requested = panelInComic(req.body?.panelId, comicId);
    if (requested) await readerCache.loadPanel(requested.page_id, requested.id);

    const sourcePanel = readerCache.getCurrentPanel();
    const wasAtBookmark = (!!sourcePanel && isAtBookmark(comic, sourcePanel))
        || (req.body?.fromPanelId != null && clientFollowsBookmark(comic, req.body.fromPanelId));

    let panel: Panel | null = null;
    switch (direction) {
        case 'next':
            panel = await readerCache.getNextPanel();
            if (panel) readerCache.readAhead(panel.page_id);
            break;
        case 'back':
            panel = await readerCache.getPreviousPanel();
            break;
        case 'first':
            panel = await readerCache.getFirstPanel();
            break;
        case 'latest':
            panel = await readerCache.getLastPanel();
            break;
        case 'page-first':
            panel = readerCache.getFirstPanelOfCurrentPage();
            break;
        case 'resume':
            panel = await readerCache.getResumePanel();
            break;
        case 'bookmark':
            panel = readerCache.getCurrentPanel();
            break;
        case 'ignore':
            if (sourcePanel) db.setUserPageIgnored(req.user!.id, sourcePanel.page_id, true);
            panel = await readerCache.skipCurrentPage();
            break;
    }

    if (!panel) {
        const message = direction === 'next' ? 'This is the latest available page.'
            : direction === 'back' ? 'This is the first available page.'
            : 'Target page/panel not found';
        res.status(404).json({ error: message });
        return;
    }

    if (direction === 'bookmark') {
        snapshotLiveBookmarkIfReplacing(req.user!.id, comic, panel.page_id, panel.id);
    }

    const shouldPersist = ALWAYS_BOOKMARK_DIRECTIONS.includes(direction)
        || (CONDITIONAL_BOOKMARK_DIRECTIONS.includes(direction) && wasAtBookmark);
    if (shouldPersist) {
        db.updateLastRead(req.user!.id, comic.id, panel.page_id, panel.id);
    }

    // Only "Save Resume Point" creates a checkpoint, never the auto-save.
    if (direction === 'bookmark') {
        db.addBookmarkHistoryEntry(req.user!.id, comic.id, panel.page_id, panel.id);
    }

    // Re-read so last_read_page/panel reflect what was just persisted.
    const updatedComic = await readerCache.getComic(true);
    if (!updatedComic) {
        res.status(404).json({ error: 'Comic not found' });
        return;
    }

    res.json({
        ...navResponse(req.user!.id, updatedComic, panel),
        // What the client's Undo needs to put things back.
        ignoredPanelId: direction === 'ignore' && sourcePanel ? sourcePanel.id : undefined
    });
});

// Undo for Ignore (the reader's toast button): un-ignores the page and
// jumps back to the panel that was showing when Ignore was clicked. If the
// client is still following its bookmark (`fromPanelId`, same compare-and-
// set as scroll-position) the bookmark comes back with it, since Ignore
// moved it forward in that case.
router.post('/:id/unignore', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    if (isNaN(comicId)) {
        res.status(400).json({ error: 'Invalid comic ID' });
        return;
    }

    const readerCache = ReaderCache.getInstance(req.user!.id, comicId);
    const comic = await readerCache.getComic(true);
    if (!comic) {
        res.status(404).json({ error: 'Comic not found' });
        return;
    }

    const target = panelInComic(req.body?.panelId, comicId);
    if (!target) {
        res.status(404).json({ error: 'That page no longer exists' });
        return;
    }

    db.setUserPageIgnored(req.user!.id, target.page_id, false);
    const panel = await readerCache.loadPanel(target.page_id, target.id);
    if (!panel) {
        res.status(404).json({ error: 'That page no longer exists' });
        return;
    }

    if (clientFollowsBookmark(comic, req.body?.fromPanelId)) {
        db.updateLastRead(req.user!.id, comic.id, panel.page_id, panel.id);
    }

    const updatedComic = await readerCache.getComic(true);
    if (!updatedComic) {
        res.status(404).json({ error: 'Comic not found' });
        return;
    }

    res.json(navResponse(req.user!.id, updatedComic, panel));
});

// Jumps to a past resume checkpoint - a preview like First/Latest: it never
// touches the live bookmark or adds a history entry, so Resume undoes it.
router.post('/:id/bookmarks/:historyId/restore', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    const historyId = Number(req.params.historyId);
    if (isNaN(comicId) || isNaN(historyId)) {
        res.status(400).json({ error: 'Invalid ID' });
        return;
    }

    const entry = db.getBookmarkHistoryEntry(req.user!.id, comicId, historyId);
    if (!entry) {
        res.status(404).json({ error: 'Bookmark history entry not found' });
        return;
    }

    const readerCache = ReaderCache.getInstance(req.user!.id, comicId);
    const comic = await readerCache.getComic(true);
    if (!comic) {
        res.status(404).json({ error: 'Comic not found' });
        return;
    }

    const panel = await readerCache.loadPanel(entry.page_id, entry.panel_id);
    if (!panel) {
        res.status(404).json({ error: 'That checkpoint no longer exists' });
        return;
    }

    res.json(navResponse(req.user!.id, comic, panel));
});

// Saves the panel open in the reader as a named bookmark. Never touches the
// resume position.
router.post('/:id/bookmarks', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    const name = (req.body.name || '').trim();
    if (isNaN(comicId)) {
        res.status(400).json({ error: 'Invalid comic ID' });
        return;
    }
    if (!name) {
        res.status(400).json({ error: 'Name is required' });
        return;
    }

    const readerCache = ReaderCache.getInstance(req.user!.id, comicId);
    const comic = await readerCache.getComic(true);
    const panel = readerCache.getCurrentPanel();
    if (!comic || !panel) {
        res.status(404).json({ error: 'Comic not found' });
        return;
    }

    db.createBookmark(req.user!.id, comicId, panel.page_id, panel.id, name);
    res.json({ bookmarks: db.getBookmarksForComic(req.user!.id, comicId) });
});

// "Go" from the reader's own 🔖 panel - a preview, like restore above.
router.post('/:id/bookmarks/:bookmarkId/go', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    const bookmarkId = Number(req.params.bookmarkId);
    if (isNaN(comicId) || isNaN(bookmarkId)) {
        res.status(400).json({ error: 'Invalid ID' });
        return;
    }

    const bookmark = db.getBookmark(req.user!.id, bookmarkId);
    if (!bookmark || bookmark.comic_id !== comicId) {
        res.status(404).json({ error: 'Bookmark not found' });
        return;
    }

    const readerCache = ReaderCache.getInstance(req.user!.id, comicId);
    const comic = await readerCache.getComic(true);
    if (!comic) {
        res.status(404).json({ error: 'Comic not found' });
        return;
    }

    const panel = await readerCache.loadPanel(bookmark.page_id, bookmark.panel_id);
    if (!panel) {
        res.status(404).json({ error: 'That bookmark no longer exists' });
        return;
    }

    res.json(navResponse(req.user!.id, comic, panel));
});

// Where tapping a new-page notification lands (public/sw.js opens
// /open/notification, resolved at tap time to the comic's own setting or
// else the account's default). "latest" opens the newest page at its first
// panel - a preview like the Latest button; "resume" opens the resume point.
router.get('/:id/open/:target', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    const userComic = isNaN(comicId) ? null : db.getUserComic(req.user!.id, comicId);
    if (!userComic) {
        res.status(404).send('Comic not found');
        return;
    }
    const target = req.params.target === 'notification'
        ? db.getEffectiveNotificationTarget(req.user!, userComic)
        : req.params.target;
    if (target !== 'latest' && target !== 'resume') {
        res.status(400).send('Invalid request');
        return;
    }

    // Not getComic(true): the reader's first load after a restart would
    // otherwise still "bootstrap" to the resume point and undo this jump.
    const readerCache = ReaderCache.getInstance(req.user!.id, comicId);
    await readerCache.getComic();
    if (target === 'latest') {
        if (await readerCache.getLastPanel()) readerCache.getFirstPanelOfCurrentPage();
    } else {
        await readerCache.getResumePanel();
    }

    res.redirect(`/reader/${comicId}`);
});

// "Go" from the bookmarks manager page: opens the reader at a known
// page/panel, as a preview.
router.get('/:id/jump/:pageId/:panelId', async (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    const pageId = Number(req.params.pageId);
    const panelId = Number(req.params.panelId);
    if (isNaN(comicId) || isNaN(pageId) || isNaN(panelId)) {
        res.status(400).send('Invalid ID');
        return;
    }

    const page = db.getPage(pageId);
    if (!page || page.comic_id !== comicId || !db.isUserSubscribed(req.user!.id, comicId)) {
        res.status(404).send('Page not found');
        return;
    }

    // Not getComic(true): the reader's first load after a restart would
    // otherwise still "bootstrap" to the resume point and undo this jump.
    const readerCache = ReaderCache.getInstance(req.user!.id, comicId);
    await readerCache.getComic();
    const panel = await readerCache.loadPanel(pageId, panelId);
    if (!panel) {
        res.status(404).send('That bookmark no longer exists');
        return;
    }

    res.redirect(`/reader/${comicId}`);
});
