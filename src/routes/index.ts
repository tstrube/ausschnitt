import { Router, Request, Response } from 'express';
import fs from 'fs';
import * as db from '../db';
import { DATA_DIR } from '../paths';
import { formatBytes } from '../utils/formatBytes';
import { formatDateTime } from '../utils/formatDate';
import { PAGE_SIZE, parsePageParam } from '../utils/pagination';
import { ReaderCache } from '../readerCache';

export const router = Router();


router.get('/', (req: Request, res: Response) => {
    const comics = db.getComicsForUser(req.user!.id);
    const usageByComic: Record<number, string> = {};
    for (const comic of comics) {
        usageByComic[comic.id] = formatBytes(db.getComicDiskUsageBytes(comic.id));
    }

    res.render('index', { comics, usageByComic });
});

// Global (not per-comic) preferences. The navbar's ⚙ links here; the
// reader's ⚙ goes to that comic's own settings.
router.get('/settings', (req: Request, res: Response) => {
    let totalUsedBytes = 0;
    for (const comic of db.getComicsForUser(req.user!.id)) {
        totalUsedBytes += db.getComicDiskUsageBytes(comic.id);
    }

    let freeSpace = 'unknown';
    try {
        const stats = fs.statfsSync(DATA_DIR);
        freeSpace = formatBytes(stats.bavail * stats.bsize);
    } catch (err) {
        console.warn('Failed to read free disk space for', DATA_DIR, err);
    }

    res.render('settings', {
        freeSpace,
        totalUsed: formatBytes(totalUsedBytes),
        globalReadingMode: db.getDefaultReadingMode(),
        globalHideScrollNav: db.getDefaultHideScrollNav(),
        newPageCheckHours: db.getNewPageCheckHours(),
        newPageCheckOptions: db.NEW_PAGE_CHECK_HOURS_OPTIONS
    });
});

router.post('/settings/reading-mode', (req: Request, res: Response) => {
    const mode = req.body.default_reading_mode === 'paged' ? 'paged' : 'scroll';
    db.setSetting('default_reading_mode', mode);
    res.redirect('/settings');
});

router.post('/settings/scroll-nav', (req: Request, res: Response) => {
    db.setSetting('default_hide_scroll_nav', req.body.default_scroll_nav === 'hide' ? 'true' : 'false');
    res.redirect('/settings');
});

router.post('/settings/notification-target', (req: Request, res: Response) => {
    db.setUserNotificationTarget(req.user!.id, req.body.notification_target === 'latest' ? 'latest' : 'resume');
    res.redirect('/settings');
});

router.post('/settings/new-page-check', (req: Request, res: Response) => {
    const hours = Number(req.body.new_page_check_hours);
    if (db.NEW_PAGE_CHECK_HOURS_OPTIONS.includes(hours)) db.setSetting('new_page_check_hours', String(hours));
    res.redirect('/settings');
});

// The ignored-pages list is shown whole (no pagination) with these sorts.
// URLs compare numerically ("/comic/9" before "/comic/10"), since most
// comics number their permalinks.
const IGNORED_SORTS = [
    ['url-asc', 'URL ↑'],
    ['url-desc', 'URL ↓'],
    ['date-asc', 'Date ↑'],
    ['date-desc', 'Date ↓']
] as const;
type IgnoredSort = typeof IGNORED_SORTS[number][0];

const urlCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function parseIgnoredSort(value: unknown): IgnoredSort {
    return IGNORED_SORTS.find(([key]) => key === value)?.[0] ?? 'date-desc';
}

function sortIgnoredPages<T extends { original_url: string }>(pages: T[], sort: IgnoredSort): T[] {
    // getIgnoredPages already returns newest first.
    if (sort === 'date-asc') return pages.reverse();
    if (sort === 'url-asc') return pages.sort((a, b) => urlCollator.compare(a.original_url, b.original_url));
    if (sort === 'url-desc') return pages.sort((a, b) => urlCollator.compare(b.original_url, a.original_url));
    return pages;
}

function requireSubscribed(req: Request, res: Response, comicId: number): boolean {
    if (isNaN(comicId) || !db.isUserSubscribed(req.user!.id, comicId)) {
        res.status(404).send('Comic not found');
        return false;
    }
    return true;
}

router.get('/comics/:id/settings', (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    if (!requireSubscribed(req, res, comicId)) return;

    const comic = db.getComic(comicId)!;
    const userComic = db.getUserComic(req.user!.id, comicId)!;
    const resumeHistoryPage = parsePageParam(req.query.resumeHistoryPage);
    const ignoredSort = parseIgnoredSort(req.query.sort);
    const tab = req.query.tab === 'history' || req.query.tab === 'ignored' ? req.query.tab : 'settings';

    res.render('comic-settings', {
        comic,
        userComic,
        tab,
        globalReadingMode: db.getDefaultReadingMode(),
        globalHideScrollNav: db.getDefaultHideScrollNav(),
        resumeHistory: db.getBookmarkHistoryPage(req.user!.id, comicId, resumeHistoryPage, PAGE_SIZE),
        resumeHistoryPage,
        resumeHistoryCap: db.MAX_BOOKMARK_HISTORY,
        ignored: sortIgnoredPages(db.getIgnoredPages(req.user!.id, comicId), ignoredSort),
        ignoredSort,
        ignoredSorts: IGNORED_SORTS,
        pageSize: PAGE_SIZE,
        formatDateTime
    });
});

router.post('/comics/:id/bookmarks/:bookmarkId/delete', (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    if (!requireSubscribed(req, res, comicId)) return;

    const bookmarkId = Number(req.params.bookmarkId);
    if (isNaN(bookmarkId)) {
        res.status(400).send('Invalid bookmark ID');
        return;
    }

    db.deleteBookmarkHistoryEntry(req.user!.id, comicId, bookmarkId);
    res.redirect(`/comics/${comicId}/settings?tab=history`);
});

router.post('/comics/:id/settings', (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    if (!requireSubscribed(req, res, comicId)) return;

    const readingMode = req.body.reading_mode === 'paged' || req.body.reading_mode === 'scroll'
        ? req.body.reading_mode
        : null;
    const hideScrollNav = req.body.scroll_nav === 'hide' ? true
        : req.body.scroll_nav === 'show' ? false
        : null;

    db.updateUserComicSettings(req.user!.id, comicId, {
        start_at_first_panel: !!req.body.start_at_first_panel,
        reading_mode: readingMode,
        hide_scroll_nav: hideScrollNav,
        notify_new_pages: !!req.body.notify_new_pages,
        notification_target: req.body.notification_target === 'resume' || req.body.notification_target === 'latest'
            ? req.body.notification_target
            : null
    });
    ReaderCache.reset(req.user!.id, comicId);
    res.redirect(`/comics/${comicId}/settings`);
});

router.post('/delete/:id', (req: Request, res: Response) => {
    const comicId = Number(req.params.id);
    if (!requireSubscribed(req, res, comicId)) return;

    // Unsubscribes; the shared cache goes once nobody is subscribed (see
    // db.removeUserFromComic).
    db.removeUserFromComic(req.user!.id, comicId);
    ReaderCache.resetForComic(comicId);
    res.redirect('/');
});

// Wipes a comic's downloaded pages and panels but keeps the comic and its
// selectors - to reclaim space or force a re-crawl. Single-user only: in
// multi-user mode the cache is shared with other accounts.
router.post('/clear/:id', (req: Request, res: Response) => {
    if (db.isMultiUser()) {
        res.status(403).send('Clear is not available in multi-user mode - cache is shared and only clears once every account has removed the comic');
        return;
    }

    const comicId = Number(req.params.id);
    if (!requireSubscribed(req, res, comicId)) return;

    db.clearComicPages(comicId);
    ReaderCache.resetForComic(comicId);
    res.redirect('/');
});

router.post('/clear-all', (req: Request, res: Response) => {
    if (db.isMultiUser()) {
        res.status(403).send('Clear is not available in multi-user mode - cache is shared and only clears once every account has removed a comic');
        return;
    }

    db.clearAllComicsPages();
    ReaderCache.resetAll();
    res.redirect('/settings');
});

// Undo on the comic settings page's Ignored tab.
router.post('/undo-ignore/:pageId', (req: Request, res: Response) => {
    const pageId = Number(req.params.pageId);
    if (isNaN(pageId)) {
        res.status(400).send('Invalid page ID');
        return;
    }

    const page = db.getPage(pageId);
    if (!page || !db.isUserSubscribed(req.user!.id, page.comic_id)) {
        res.status(404).send('Page not found');
        return;
    }

    db.setUserPageIgnored(req.user!.id, pageId, false);
    ReaderCache.reset(req.user!.id, page.comic_id);
    res.redirect(`/comics/${page.comic_id}/settings?tab=ignored&sort=${parseIgnoredSort(req.body.sort)}`);
});
