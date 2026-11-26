import { Router, Request, Response } from 'express';
import fs from 'fs';
import * as db from '../db';
import { DATA_DIR } from '../paths';
import { formatBytes } from '../utils/formatBytes';
import { formatDateTime } from '../utils/formatDate';
import { PAGE_SIZE, parsePageParam } from '../utils/pagination';
import { ReaderCache } from '../readerCache';
import { applyReadingDirection } from '../utils/fetch';
import { isAllowedNtfyUrl, parseNtfyUrl } from '../utils/ntfy';
import { Schedule, WEEKDAYS, describeSchedule, parseDays, parseTime, serverTimeZone } from '../utils/schedule';

export const router = Router();


router.get('/', (req: Request, res: Response) => {
    const comics = db.getComicsForUser(req.user!.id);
    const usageByComic: Record<number, string> = {};
    for (const comic of comics) {
        usageByComic[comic.id] = formatBytes(db.getComicDiskUsageBytes(comic.id));
    }

    res.render('index', { comics, usageByComic, withNewPages: db.getComicIdsWithNewPages(req.user!.id) });
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
        weekdays: WEEKDAYS,
        scheduleText: describeSchedule(req.user!.notify_schedule),
        ntfyError: typeof req.query.ntfy === 'string' ? NTFY_ERRORS[req.query.ntfy] ?? null : null,
        timezoneLabel: serverTimeZone()
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
    db.setUserNotificationTarget(req.user!.id, db.parseNotificationTarget(req.body.notification_target) ?? 'new');
    res.redirect('/settings');
});

// The account's ntfy topic (utils/ntfy.ts): saved with the address the app
// is used from, which a tap on its notifications opens. An empty URL turns
// it off; an empty token keeps the saved one.
const NTFY_ERRORS: Record<string, string> = {
    invalid: 'Not an ntfy topic URL - like https://ntfy.sh/your-topic',
    private: 'Only public addresses - a local ntfy server can be set by an admin'
};

router.post('/settings/ntfy', async (req: Request, res: Response) => {
    const raw = typeof req.body.ntfy_url === 'string' ? req.body.ntfy_url.trim() : '';
    if (!raw) {
        db.setUserNtfy(req.user!.id, null);
        res.redirect('/settings');
        return;
    }
    const topic = parseNtfyUrl(raw);
    if (!topic) {
        res.redirect('/settings?ntfy=invalid');
        return;
    }
    const url = `${topic.base}${topic.topic}`;
    if (!await isAllowedNtfyUrl(url, req.user!.is_admin || !db.isMultiUser())) {
        res.redirect('/settings?ntfy=private');
        return;
    }
    const token = typeof req.body.ntfy_token === 'string' && req.body.ntfy_token.trim()
        ? req.body.ntfy_token.trim()
        : req.user!.ntfy?.token ?? null;
    db.setUserNtfy(req.user!.id, { url, token, origin: req.get('origin') || `${req.protocol}://${req.get('host')}` });
    res.redirect('/settings');
});

router.post('/settings/notify-combine', (req: Request, res: Response) => {
    db.setUserNotifyCombine(req.user!.id, req.body.notify_combine !== 'each');
    res.redirect('/settings');
});

// The account's default new-page check schedule (no day checked = never).
router.post('/settings/notification-schedule', (req: Request, res: Response) => {
    db.setUserNotifySchedule(req.user!.id, {
        days: parseDays(req.body.notify_days),
        time: parseTime(req.body.notify_time) ?? req.user!.notify_schedule.time
    });
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
        weekdays: WEEKDAYS,
        defaultScheduleText: describeSchedule(req.user!.notify_schedule),
        resumeHistory: db.getBookmarkHistoryPage(req.user!.id, comicId, resumeHistoryPage, PAGE_SIZE),
        resumeHistoryPage,
        resumeHistoryCap: db.MAX_BOOKMARK_HISTORY,
        ignored: sortIgnoredPages(db.getIgnoredPages(req.user!.id, comicId), ignoredSort),
        ignoredSort,
        ignoredSorts: IGNORED_SORTS,
        pageSize: PAGE_SIZE,
        usage: formatBytes(db.getComicDiskUsageBytes(comicId)),
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

// A comic's own check schedule from its settings form, or null for the
// account's. Switching to "own" (the day/time fields aren't on the form
// yet) starts from the account's schedule.
function comicSchedule(req: Request): Schedule | null {
    if (req.body.notify_schedule !== 'own') return null;
    if (req.body.notify_time === undefined) return { ...req.user!.notify_schedule };
    return {
        days: parseDays(req.body.notify_days),
        time: parseTime(req.body.notify_time) ?? req.user!.notify_schedule.time
    };
}

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
        notification_target: db.parseNotificationTarget(req.body.notification_target),
        notify_schedule: comicSchedule(req)
    });
    ReaderCache.reset(req.user!.id, comicId);

    // Shared by every subscriber, like the panels it orders, so only an
    // admin changes it (the field is only on an admin's form).
    const direction = req.body.reading_direction === 'rtl' ? 'rtl'
        : req.body.reading_direction === 'ltr' ? 'ltr'
        : null;
    const comic = db.getComic(comicId)!;
    if (req.user!.is_admin && direction && comic.reading_direction !== direction) {
        db.setComicReadingDirection(comicId, direction);
        applyReadingDirection({ ...comic, reading_direction: direction });
        ReaderCache.resetForComic(comicId);
    }
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
    res.redirect(`/comics/${comicId}/settings`);
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
