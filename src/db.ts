import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { Bookmark, Comic, ComicRow, Direction, Page, Panel, ReaderComic, SelectorFingerprint, UserComic } from './types';
import { DB_PATH, imagesDirForComic } from './paths';

let db: Database.Database;

function initDb(): void {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        -- Shared comic cache: the comic itself and its downloaded pages and
        -- panels, deduped by URL across accounts. Per-account state lives in
        -- comic_subscriptions, user_ignored_pages, bookmark_history and
        -- bookmarks.
        CREATE TABLE IF NOT EXISTS comics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT,
            title TEXT,
            selector_image TEXT,
            selector_next TEXT,
            selector_back TEXT,
            selector_first TEXT,
            selector_latest TEXT,
            -- LRU signal for disk-cap eviction (see evictOverCapIfNeeded):
            -- bumped whenever anyone reads a panel. NULL sorts as least
            -- recently used.
            cache_last_accessed_at TEXT DEFAULT NULL,
            -- New-page detection (src/newPageNotifier.ts): what the comic's
            -- "Latest" link pointed at last check, and when that ran.
            latest_signature TEXT DEFAULT NULL,
            latest_checked_at INTEGER DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS pages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            comic_id INTEGER,
            original_url TEXT,
            prev_id INTEGER,
            next_id INTEGER,
            page_order INTEGER,
            -- sha256 of the downloaded image - lets a homepage-anchored tip
            -- (fetch.ts's checkHomepageForNewPage) detect a new strip by
            -- content. NULL when unknown.
            image_hash TEXT DEFAULT NULL
        );

        CREATE TABLE IF NOT EXISTS panels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            page_id INTEGER,
            panel_number INTEGER,
            image_path TEXT
        );

        -- "Resume history": checkpoints from Save Resume Point. source is
        -- 'user' for the click itself, 'auto' for the snapshot of the
        -- position it replaced (see snapshotLiveBookmarkIfReplacing) - the
        -- two can land in the same millisecond.
        CREATE TABLE IF NOT EXISTS bookmark_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            comic_id INTEGER,
            user_id INTEGER,
            page_id INTEGER,
            panel_id INTEGER,
            created_at TEXT DEFAULT (datetime('now')),
            source TEXT DEFAULT 'user'
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT,
            is_admin INTEGER DEFAULT 0,
            has_seen_intro INTEGER DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            -- Tapping a new-page notification opens the resume point
            -- ('resume') or the newest page ('latest').
            notification_target TEXT DEFAULT 'resume'
        );

        CREATE TABLE IF NOT EXISTS sessions (
            sid TEXT PRIMARY KEY,
            session_json TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );

        -- One row per (account, comic): subscribing shares the comic's cache,
        -- this holds everything that's that account's own. NULL in
        -- reading_mode/hide_scroll_nav/notification_target means "use the
        -- default" (global setting or the account's own).
        CREATE TABLE IF NOT EXISTS comic_subscriptions (
            user_id INTEGER,
            comic_id INTEGER,
            last_read_page INTEGER DEFAULT NULL,
            last_read_panel INTEGER DEFAULT NULL,
            reading_mode TEXT DEFAULT NULL,
            start_at_first_panel INTEGER DEFAULT 0,
            hide_scroll_nav INTEGER DEFAULT NULL,
            notify_new_pages INTEGER DEFAULT 1,
            notification_target TEXT DEFAULT NULL,
            PRIMARY KEY (user_id, comic_id)
        );

        CREATE TABLE IF NOT EXISTS user_ignored_pages (
            user_id INTEGER,
            page_id INTEGER,
            ignored_at TEXT DEFAULT (datetime('now')),
            PRIMARY KEY (user_id, page_id)
        );

        CREATE TABLE IF NOT EXISTS bookmarks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            comic_id INTEGER,
            page_id INTEGER,
            panel_id INTEGER,
            name TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        -- One row per device/browser that turned on new-page notifications
        -- (see src/newPageNotifier.ts). origin is the address the app was
        -- opened from when subscribing - used as the push "contact" (VAPID
        -- subject), which push services require to be a real https URL.
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            origin TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );
    `);
}

// --- Settings (global key/value) ---

export function getSetting(key: string): string | null {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return row?.value ?? null;
}

export function setSetting(key: string, value: string): void {
    db.prepare(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
}

export function isMultiUser(): boolean {
    return getSetting('multi_user_enabled') === 'true';
}

// --- Users ---

export interface User {
    id: number;
    username: string;
    password_hash: string | null;
    is_admin: boolean;
    has_seen_intro: boolean;
    /** Where tapping a new-page notification takes this account. */
    notification_target: NotificationTarget;
}

export type NotificationTarget = 'resume' | 'latest';

interface UserRow {
    id: number;
    username: string;
    password_hash: string | null;
    is_admin: number;
    has_seen_intro: number;
    notification_target: string | null;
}

function mapUserRow(row: UserRow): User {
    return {
        id: row.id,
        username: row.username,
        password_hash: row.password_hash,
        is_admin: !!row.is_admin,
        has_seen_intro: !!row.has_seen_intro,
        notification_target: row.notification_target === 'latest' ? 'latest' : 'resume'
    };
}

export function setUserNotificationTarget(id: number, target: NotificationTarget): void {
    db.prepare(`UPDATE users SET notification_target = ? WHERE id = ?`).run(target, id);
}

// Whether any account exists yet - the setup wizard's own gate (see
// src/middleware/auth.ts): everything redirects to /setup until this is true.
export function hasAnyUser(): boolean {
    const row = db.prepare(`SELECT 1 FROM users LIMIT 1`).get();
    return !!row;
}

export function createUser(username: string, passwordHash: string | null, isAdmin: boolean): number {
    const result = db.prepare(`
        INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)
    `).run(username, passwordHash, isAdmin ? 1 : 0);
    return result.lastInsertRowid as number;
}

export function getUserById(id: number): User | null {
    const row = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined;
    return row ? mapUserRow(row) : null;
}

export function getUserByUsername(username: string): User | null {
    const row = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username) as UserRow | undefined;
    return row ? mapUserRow(row) : null;
}

export function listUsers(): User[] {
    const rows = db.prepare(`SELECT * FROM users ORDER BY id`).all() as UserRow[];
    return rows.map(mapUserRow);
}

// Removes the account and everything that's only its own; a comic it was
// the last subscriber of goes too (see removeUserFromComic).
export function deleteUser(id: number): void {
    for (const comic of getComicsForUser(id)) {
        removeUserFromComic(id, comic.id);
    }
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`).run(id);
    db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
}

export function setUserPassword(id: number, passwordHash: string | null): void {
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(passwordHash, id);
}

export function markIntroSeen(id: number): void {
    db.prepare(`UPDATE users SET has_seen_intro = 1 WHERE id = ?`).run(id);
}

// --- Sessions (express-session store backing - see src/utils/sessionStore.ts) ---

export function getSessionRow(sid: string): { session_json: string; expires_at: number } | null {
    const row = db.prepare(`SELECT session_json, expires_at FROM sessions WHERE sid = ?`).get(sid) as { session_json: string; expires_at: number } | undefined;
    return row ?? null;
}

export function setSessionRow(sid: string, sessionJson: string, expiresAt: number): void {
    db.prepare(`
        INSERT INTO sessions (sid, session_json, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(sid) DO UPDATE SET session_json = excluded.session_json, expires_at = excluded.expires_at
    `).run(sid, sessionJson, expiresAt);
}

export function destroySessionRow(sid: string): void {
    db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
}

export function pruneExpiredSessions(): void {
    db.prepare(`DELETE FROM sessions WHERE expires_at < ?`).run(Date.now());
}

export type ReadingMode = 'paged' | 'scroll';
// Endless scroll unless the global setting explicitly says paged - so a
// fresh install (setting never saved) starts in scroll mode.
export function getDefaultReadingMode(): ReadingMode {
    return getSetting('default_reading_mode') === 'paged' ? 'paged' : 'scroll';
}

// The comic's own reading mode if set, otherwise the global default.
export function getEffectiveReadingMode(userComic: Pick<UserComic, 'reading_mode'>): ReadingMode {
    if (userComic.reading_mode === 'paged' || userComic.reading_mode === 'scroll') return userComic.reading_mode;
    return getDefaultReadingMode();
}

// Whether endless scroll hides its bottom First/Latest bar. Shown unless the
// global setting explicitly says hide.
export function getDefaultHideScrollNav(): boolean {
    return getSetting('default_hide_scroll_nav') === 'true';
}

export function getEffectiveHideScrollNav(userComic: Pick<UserComic, 'hide_scroll_nav'>): boolean {
    if (userComic.hide_scroll_nav !== null) return userComic.hide_scroll_nav;
    return getDefaultHideScrollNav();
}

function hideScrollNavFromDb(value: number | null): boolean | null {
    return value === null ? null : !!value;
}

initDb();

// --- Comic CRUD ---

function parseSelector(value: string | null): SelectorFingerprint | null {
    return value ? JSON.parse(value) as SelectorFingerprint : null;
}

function mapComicRow(row: ComicRow): Comic {
    return {
        id: row.id,
        url: row.url,
        title: row.title,
        selector_image: parseSelector(row.selector_image),
        selector_next: parseSelector(row.selector_next),
        selector_back: parseSelector(row.selector_back),
        selector_first: parseSelector(row.selector_first),
        selector_latest: parseSelector(row.selector_latest)
    };
}

// Comics are shared, deduped by URL - if another account already added this
// exact URL, this just subscribes the new user to the existing comic (and
// its already-downloaded cache) instead of creating a duplicate. Only a
// genuinely new URL creates a new row.
export function insertComic(url: string, title: string, userId: number): number {
    const existing = getComicByUrl(url);
    const comicId = existing
        ? existing.id
        : (db.prepare(`INSERT INTO comics (url, title) VALUES (?, ?)`).run(url, title).lastInsertRowid as number);

    db.prepare(`INSERT OR IGNORE INTO comic_subscriptions (user_id, comic_id) VALUES (?, ?)`).run(userId, comicId);
    return comicId;
}

export function getComic(id: number): Comic | null {
    const row = db.prepare(`SELECT * FROM comics WHERE id = ?`).get(id) as ComicRow | undefined;
    return row ? mapComicRow(row) : null;
}

export function getComicByUrl(url: string): Comic | null {
    const row = db.prepare(`SELECT * FROM comics WHERE url = ?`).get(url) as ComicRow | undefined;
    return row ? mapComicRow(row) : null;
}

// All comics, regardless of who's subscribed - only for genuinely global
// operations. Anything a user sees or acts on goes through getComicsForUser.
function getComics(): Comic[] {
    const rows = db.prepare(`SELECT * FROM comics`).all() as ComicRow[];
    return rows.map(mapComicRow);
}

export function getComicsForUser(userId: number): Comic[] {
    const rows = db.prepare(`
        SELECT comics.* FROM comics
        JOIN comic_subscriptions ON comic_subscriptions.comic_id = comics.id
        WHERE comic_subscriptions.user_id = ?
    `).all(userId) as ComicRow[];
    return rows.map(mapComicRow);
}

export function isUserSubscribed(userId: number, comicId: number): boolean {
    return !!db.prepare(`
        SELECT 1 FROM comic_subscriptions WHERE user_id = ? AND comic_id = ?
    `).get(userId, comicId);
}

function getComicSubscriberCount(comicId: number): number {
    const row = db.prepare(`
        SELECT COUNT(*) as count FROM comic_subscriptions WHERE comic_id = ?
    `).get(comicId) as { count: number };
    return row.count;
}

// Unsubscribes one user from a comic, dropping their own state for it. The
// comic and its pages/panels are shared cache other accounts may still be
// reading, so they're only wiped once the last subscriber leaves - in
// single-user mode, immediately.
export function removeUserFromComic(userId: number, comicId: number): void {
    db.prepare(`DELETE FROM comic_subscriptions WHERE user_id = ? AND comic_id = ?`).run(userId, comicId);
    db.prepare(`DELETE FROM bookmarks WHERE user_id = ? AND comic_id = ?`).run(userId, comicId);
    db.prepare(`DELETE FROM bookmark_history WHERE user_id = ? AND comic_id = ?`).run(userId, comicId);
    db.prepare(`
        DELETE FROM user_ignored_pages
        WHERE user_id = ? AND page_id IN (SELECT id FROM pages WHERE comic_id = ?)
    `).run(userId, comicId);
    if (getComicSubscriberCount(comicId) === 0) {
        deleteComic(comicId);
    }
}

// A comic's shared fields (title/url/selectors) merged with one user's
// reading state - the shape ReaderCache and the reader routes work with.
// Null if this user isn't subscribed.
export function getReaderComic(userId: number, comicId: number): ReaderComic | null {
    const row = db.prepare(`
        SELECT
            comics.id, comics.url, comics.title,
            comics.selector_image, comics.selector_next, comics.selector_back,
            comics.selector_first, comics.selector_latest,
            comic_subscriptions.last_read_page, comic_subscriptions.last_read_panel,
            comic_subscriptions.reading_mode, comic_subscriptions.start_at_first_panel,
            comic_subscriptions.hide_scroll_nav
        FROM comics
        JOIN comic_subscriptions ON comic_subscriptions.comic_id = comics.id
        WHERE comics.id = ? AND comic_subscriptions.user_id = ?
    `).get(comicId, userId) as (ComicRow & { last_read_page: number | null; last_read_panel: number | null; reading_mode: string | null; start_at_first_panel: number; hide_scroll_nav: number | null }) | undefined;
    if (!row) return null;

    return {
        ...mapComicRow(row),
        last_read_page: row.last_read_page,
        last_read_panel: row.last_read_panel,
        reading_mode: row.reading_mode,
        start_at_first_panel: !!row.start_at_first_panel,
        hide_scroll_nav: hideScrollNavFromDb(row.hide_scroll_nav)
    };
}

export function getUserComic(userId: number, comicId: number): UserComic | null {
    const row = db.prepare(`
        SELECT * FROM comic_subscriptions WHERE user_id = ? AND comic_id = ?
    `).get(userId, comicId) as { user_id: number; comic_id: number; last_read_page: number | null; last_read_panel: number | null; reading_mode: string | null; start_at_first_panel: number; hide_scroll_nav: number | null; notify_new_pages: number; notification_target: string | null } | undefined;
    if (!row) return null;

    return {
        ...row,
        start_at_first_panel: !!row.start_at_first_panel,
        hide_scroll_nav: hideScrollNavFromDb(row.hide_scroll_nav),
        notify_new_pages: !!row.notify_new_pages,
        notification_target: row.notification_target === 'resume' || row.notification_target === 'latest' ? row.notification_target : null
    };
}

// The comic's own choice if set, otherwise the account's default.
export function getEffectiveNotificationTarget(user: Pick<User, 'notification_target'>, userComic: Pick<UserComic, 'notification_target'>): NotificationTarget {
    return userComic.notification_target ?? user.notification_target;
}

export function updateUserComicSettings(userId: number, comicId: number, data: { reading_mode: string | null; start_at_first_panel: boolean; hide_scroll_nav: boolean | null; notify_new_pages: boolean; notification_target: NotificationTarget | null }): void {
    db.prepare(`
        UPDATE comic_subscriptions
        SET reading_mode = ?, start_at_first_panel = ?, hide_scroll_nav = ?, notify_new_pages = ?, notification_target = ?
        WHERE user_id = ? AND comic_id = ?
    `).run(data.reading_mode || null, data.start_at_first_panel ? 1 : 0, data.hide_scroll_nav === null ? null : data.hide_scroll_nav ? 1 : 0, data.notify_new_pages ? 1 : 0, data.notification_target, userId, comicId);
}

const SELECTOR_COLUMNS = ['selector_image', 'selector_next', 'selector_back', 'selector_first', 'selector_latest'] as const;

// `selectors` comes straight from the client, so only known columns are
// written.
export function updateComicSelectors(
    comicId: number,
    selectors: Partial<Record<typeof SELECTOR_COLUMNS[number], SelectorFingerprint>>
): void {
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    for (const column of SELECTOR_COLUMNS) {
        if (!(column in selectors)) continue;
        const value = selectors[column];
        updates.push(`${column} = ?`);
        values.push(value ? JSON.stringify(value) : null);
    }

    if (updates.length === 0) return;

    values.push(comicId);
    db.prepare(`UPDATE comics SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function updateLastRead(userId: number, comicId: number, pageId: number | null, panelId: number | null): void {
    db.prepare(`
        UPDATE comic_subscriptions
        SET last_read_page = ?, last_read_panel = ?
        WHERE user_id = ? AND comic_id = ?
    `).run(pageId, panelId, userId, comicId);
}

export type BookmarkSource = 'user' | 'auto';

export interface BookmarkHistoryEntry {
    id: number;
    comic_id: number;
    user_id: number;
    page_id: number;
    panel_id: number;
    created_at: string;
    source: BookmarkSource;
}

// Written by "Save Resume Point" (source: 'user') and, right before it
// overwrites the live bookmark, a snapshot of the position it replaces
// (source: 'auto' - see snapshotLiveBookmarkIfReplacing in
// routes/reader.ts): a short trail of checkpoints, not a record of every
// page read. Capped at MAX_BOOKMARK_HISTORY per user and comic, oldest
// dropped first.
export const MAX_BOOKMARK_HISTORY = 10;

export function addBookmarkHistoryEntry(userId: number, comicId: number, pageId: number, panelId: number, source: BookmarkSource = 'user'): void {
    // Millisecond ISO timestamp - the column default only has seconds.
    db.prepare(`
        INSERT INTO bookmark_history (comic_id, user_id, page_id, panel_id, created_at, source) VALUES (?, ?, ?, ?, ?, ?)
    `).run(comicId, userId, pageId, panelId, new Date().toISOString(), source);

    db.prepare(`
        DELETE FROM bookmark_history
        WHERE comic_id = ? AND user_id = ? AND id NOT IN (
            SELECT id FROM bookmark_history WHERE comic_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
        )
    `).run(comicId, userId, comicId, userId, MAX_BOOKMARK_HISTORY);
}

export function deleteBookmarkHistoryEntry(userId: number, comicId: number, id: number): void {
    db.prepare(`DELETE FROM bookmark_history WHERE id = ? AND comic_id = ? AND user_id = ?`).run(id, comicId, userId);
}

// The reader's own history panel - the full list is on the comic's
// settings page.
export function getRecentBookmarkHistory(userId: number, comicId: number, limit: number): BookmarkHistoryEntry[] {
    return db.prepare(`
        SELECT * FROM bookmark_history WHERE comic_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
    `).all(comicId, userId, limit) as BookmarkHistoryEntry[];
}

export interface Paginated<T> {
    entries: T[];
    total: number;
}

export function getBookmarkHistoryPage(userId: number, comicId: number, page: number, pageSize: number): Paginated<BookmarkHistoryEntry> {
    const total = (db.prepare(`
        SELECT COUNT(*) as count FROM bookmark_history WHERE comic_id = ? AND user_id = ?
    `).get(comicId, userId) as { count: number }).count;
    const entries = db.prepare(`
        SELECT * FROM bookmark_history WHERE comic_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?
    `).all(comicId, userId, pageSize, (page - 1) * pageSize) as BookmarkHistoryEntry[];
    return { entries, total };
}

export function getBookmarkHistoryEntry(userId: number, comicId: number, historyId: number): BookmarkHistoryEntry | null {
    return db.prepare(`
        SELECT * FROM bookmark_history WHERE id = ? AND comic_id = ? AND user_id = ?
    `).get(historyId, comicId, userId) as BookmarkHistoryEntry ?? null;
}

function deleteComic(id: number): void {
    clearComicPages(id);
    db.prepare(`DELETE FROM bookmarks WHERE comic_id = ?`).run(id);
    db.prepare(`DELETE FROM comics WHERE id = ?`).run(id);
}

// Deletes every crawled page/panel for a comic and their image files, but
// keeps the comic row itself (title/url/selectors) - used by "Clear" and by
// deleteComic. Each comic's images live in their own folder, so this is one
// recursive delete of that folder, including any file the database doesn't
// reference.
export function clearComicPages(id: number): void {
    db.prepare(`DELETE FROM user_ignored_pages WHERE page_id IN (SELECT id FROM pages WHERE comic_id = ?)`).run(id);
    db.prepare(`DELETE FROM panels WHERE page_id IN (SELECT id FROM pages WHERE comic_id = ?)`).run(id);
    db.prepare(`DELETE FROM pages WHERE comic_id = ?`).run(id);
    db.prepare(`DELETE FROM bookmark_history WHERE comic_id = ?`).run(id);
    // Reading position only - the per-comic settings survive a cache wipe.
    db.prepare(`UPDATE comic_subscriptions SET last_read_page = NULL, last_read_panel = NULL WHERE comic_id = ?`).run(id);

    const dir = imagesDirForComic(id);
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
        console.warn(`Failed to remove image folder for comic ${id}: ${dir}`, err);
    }
}

export function clearAllComicsPages(): void {
    for (const comic of getComics()) {
        clearComicPages(comic.id);
    }
}

// Total size of every file in a comic's image folder.
export function getComicDiskUsageBytes(id: number): number {
    const dir = imagesDirForComic(id);
    let total = 0;

    const walk = (current: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const entryPath = path.join(current, entry.name);
            if (entry.isDirectory()) walk(entryPath);
            else {
                try {
                    total += fs.statSync(entryPath).size;
                } catch {
                    // File may have been removed concurrently - skip it.
                }
            }
        }
    };
    walk(dir);
    return total;
}

// --- Page CRUD ---

// Never links next_id/prev_id: page_order is only an insertion/sort index,
// and a First/Latest insertion can land next to a page thousands of strips
// away. Callers set the one link a crawl confirmed via setPageLinkVerified.
export function insertPage(comic_id: number, original_url: string, direction: Direction, ref_page_id: number | null = null, image_hash: string | null = null): number {
    const page_order = getInsertOrder(comic_id, direction, ref_page_id);

    const stmt = db.prepare(`
        INSERT INTO pages (
            comic_id, original_url, page_order, image_hash
        ) VALUES (?, ?, ?, ?)
    `);
    const result = stmt.run(
        comic_id,
        original_url,
        page_order,
        image_hash
    );

    return result.lastInsertRowid as number;
}

function getInsertOrder(
    comicId: number,
    direction: Direction,
    refPageId: number | null = null
): number {
    if (direction === 'first') {
        const row = db.prepare(`SELECT MIN(page_order) as min FROM pages WHERE comic_id = ?`).get(comicId) as { min: number } | undefined;
        return (row?.min ?? 0) - 1;
    }

    if (direction === 'latest') {
        const row = db.prepare(`SELECT MAX(page_order) as max FROM pages WHERE comic_id = ?`).get(comicId) as { max: number } | undefined;
        return (row?.max ?? -1) + 1;
    }

    if (!refPageId) throw new Error(`refPageId required for position "${direction}"`);
    const refPage = getPage(refPageId);
    if (!refPage) throw new Error('Reference page not found');

    const baseOrder = refPage.page_order;

    // Shift pages to make space
    const shiftStart = direction === 'back' ? baseOrder : baseOrder + 1;
    db.prepare(`
        UPDATE pages
        SET page_order = page_order + 1
        WHERE comic_id = ? AND page_order >= ?
    `).run(comicId, shiftStart);

    return direction === 'back' ? baseOrder : baseOrder + 1;
}

export function setPageLinkVerified(
    sourceId: number,
    targetId: number,
    direction: Direction
) {
    if (direction === 'next') {
        db.prepare(`
            UPDATE pages
            SET next_id = ?
            WHERE id = ?
        `).run(targetId, sourceId);

        db.prepare(`
            UPDATE pages
            SET prev_id = ?
            WHERE id = ?
        `).run(sourceId, targetId);
    } else if (direction === 'back') {
        db.prepare(`
            UPDATE pages
            SET prev_id = ?
            WHERE id = ?
        `).run(targetId, sourceId);

        db.prepare(`
            UPDATE pages
            SET next_id = ?
            WHERE id = ?
        `).run(sourceId, targetId);
    }
}

export function getPage(pageId: number): Page | null {
    return db.prepare(`SELECT * FROM pages WHERE id = ?`).get(pageId) as Page ?? null;
}

// Scoped by comic_id - two different comics can register overlapping or
// identical URLs (the same site added twice, two comics sharing a domain),
// and one comic's navigation must never see another comic's pages.
export function getPageByUrl(comicId: number, originalUrl: string): Page | null {
    return db.prepare(`SELECT * FROM pages WHERE comic_id = ? AND original_url = ?`).get(comicId, originalUrl) as Page ?? null;
}

// Ignoring a page never deletes it - navigation just steps over it (see
// ReaderCache.firstNonIgnoredPage). Per account and always reversible.
export function isPageIgnoredByUser(userId: number, pageId: number): boolean {
    return !!db.prepare(`SELECT 1 FROM user_ignored_pages WHERE user_id = ? AND page_id = ?`).get(userId, pageId);
}

export function setUserPageIgnored(userId: number, pageId: number, ignored: boolean): void {
    if (ignored) {
        db.prepare(`INSERT OR IGNORE INTO user_ignored_pages (user_id, page_id) VALUES (?, ?)`).run(userId, pageId);
    } else {
        db.prepare(`DELETE FROM user_ignored_pages WHERE user_id = ? AND page_id = ?`).run(userId, pageId);
    }
}

export function getIgnoredPages(userId: number, comicId: number): (Page & { ignored_at: string })[] {
    return db.prepare(`
        SELECT pages.*, user_ignored_pages.ignored_at FROM user_ignored_pages
        JOIN pages ON pages.id = user_ignored_pages.page_id
        WHERE user_ignored_pages.user_id = ? AND pages.comic_id = ?
        ORDER BY user_ignored_pages.ignored_at DESC, pages.id DESC
    `).all(userId, comicId) as (Page & { ignored_at: string })[];
}

// --- Panel CRUD ---

export function insertPanel(data: {
    page_id: number;
    panel_number: number;
    image_path: string;
}): number {
    const stmt = db.prepare(`
        INSERT INTO panels (page_id, panel_number, image_path)
        VALUES (?, ?, ?)
    `);
    const result = stmt.run(data.page_id, data.panel_number, data.image_path);
    return result.lastInsertRowid as number;
}

export function getPanels(pageId: number): Panel[] {
    return db.prepare(`
        SELECT * FROM panels
        WHERE page_id = ?
        ORDER BY panel_number ASC
    `).all(pageId) as Panel[];
}

export function getPanelById(panelId: number): Panel | null {
    return db.prepare(`SELECT * FROM panels WHERE id = ?`).get(panelId) as Panel ?? null;
}

// --- Named bookmarks (see Bookmark in types.ts) ---

export function createBookmark(userId: number, comicId: number, pageId: number, panelId: number, name: string): number {
    const result = db.prepare(`
        INSERT INTO bookmarks (user_id, comic_id, page_id, panel_id, name) VALUES (?, ?, ?, ?, ?)
    `).run(userId, comicId, pageId, panelId, name);
    return result.lastInsertRowid as number;
}

// The reader's own 🔖 panel - the full cross-comic list is on /bookmarks.
export function getBookmarksForComic(userId: number, comicId: number): Bookmark[] {
    return db.prepare(`
        SELECT * FROM bookmarks WHERE user_id = ? AND comic_id = ? ORDER BY created_at DESC, id DESC
    `).all(userId, comicId) as Bookmark[];
}

// Every bookmark this user has, across every comic - the manager page.
export function getBookmarksPageForUser(userId: number, page: number, pageSize: number): Paginated<Bookmark & { comic_title: string }> {
    const total = (db.prepare(`SELECT COUNT(*) as count FROM bookmarks WHERE user_id = ?`).get(userId) as { count: number }).count;
    const entries = db.prepare(`
        SELECT bookmarks.*, comics.title as comic_title FROM bookmarks
        JOIN comics ON comics.id = bookmarks.comic_id
        WHERE bookmarks.user_id = ?
        ORDER BY bookmarks.created_at DESC, bookmarks.id DESC
        LIMIT ? OFFSET ?
    `).all(userId, pageSize, (page - 1) * pageSize) as (Bookmark & { comic_title: string })[];
    return { entries, total };
}

export function getBookmark(userId: number, id: number): Bookmark | null {
    return db.prepare(`SELECT * FROM bookmarks WHERE id = ? AND user_id = ?`).get(id, userId) as Bookmark ?? null;
}

export function renameBookmark(userId: number, id: number, name: string): void {
    db.prepare(`UPDATE bookmarks SET name = ? WHERE id = ? AND user_id = ?`).run(name, id, userId);
}

export function deleteBookmark(userId: number, id: number): void {
    db.prepare(`DELETE FROM bookmarks WHERE id = ? AND user_id = ?`).run(id, userId);
}

// --- Disk-usage cap & LRU eviction ---

export function getTotalDiskUsageBytes(): number {
    return getComics().reduce((sum, comic) => sum + getComicDiskUsageBytes(comic.id), 0);
}

// Bumped whenever any user views a panel of this comic - the LRU signal
// for disk-cap eviction (see getLeastRecentlyAccessedComic).
export function touchComicCacheAccess(comicId: number): void {
    db.prepare(`UPDATE comics SET cache_last_accessed_at = ? WHERE id = ?`).run(new Date().toISOString(), comicId);
}

// Least-recently-read comic, excluding ones already handled in the current
// eviction pass (see evictOverCapIfNeeded). Never-read comics come first.
export function getLeastRecentlyAccessedComic(excludeIds: number[] = []): Comic | null {
    const placeholders = excludeIds.map(() => '?').join(',');
    const row = db.prepare(`
        SELECT * FROM comics
        ${excludeIds.length ? `WHERE id NOT IN (${placeholders})` : ''}
        ORDER BY (cache_last_accessed_at IS NULL) DESC, cache_last_accessed_at ASC
        LIMIT 1
    `).get(...excludeIds) as ComicRow | undefined;
    return row ? mapComicRow(row) : null;
}

// --- New-page notifications (see src/newPageNotifier.ts) ---

export const NEW_PAGE_CHECK_HOURS_OPTIONS = [0, 1, 3, 6, 12, 24];
// How often each comic's site is asked for a new page; 0 = never. 6 hours
// unless configured - often enough for daily comics, gentle on their sites.
export function getNewPageCheckHours(): number {
    const raw = getSetting('new_page_check_hours');
    const hours = raw === null ? 6 : Number(raw);
    return NEW_PAGE_CHECK_HOURS_OPTIONS.includes(hours) ? hours : 6;
}

export interface PushSubscriptionRow {
    id: number;
    user_id: number;
    endpoint: string;
    p256dh: string;
    auth: string;
    origin: string;
}

// Upsert by endpoint - a browser re-reports the same subscription on every
// visit (public/js/notifications.js), and a device that switched accounts
// moves over to the new one.
export function savePushSubscription(userId: number, sub: { endpoint: string; p256dh: string; auth: string; origin: string }): void {
    db.prepare(`
        INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, origin) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, origin = excluded.origin
    `).run(userId, sub.endpoint, sub.p256dh, sub.auth, sub.origin);
}

export function deletePushSubscription(userId: number, endpoint: string): void {
    db.prepare(`DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`).run(userId, endpoint);
}

export function getPushSubscriptionsForUser(userId: number): PushSubscriptionRow[] {
    return db.prepare(`SELECT * FROM push_subscriptions WHERE user_id = ?`).all(userId) as PushSubscriptionRow[];
}

// Comics worth checking at all: at least one subscriber who hasn't muted
// this comic AND has a device with notifications turned on. With nobody
// opted in, the checker never contacts any comic site.
export function getComicsWatchedForNewPages(): (Comic & { latest_signature: string | null; latest_checked_at: number | null })[] {
    const rows = db.prepare(`
        SELECT DISTINCT comics.* FROM comics
        JOIN comic_subscriptions ON comic_subscriptions.comic_id = comics.id
        JOIN push_subscriptions ON push_subscriptions.user_id = comic_subscriptions.user_id
        WHERE comic_subscriptions.notify_new_pages = 1
          AND comics.selector_image IS NOT NULL AND comics.selector_latest IS NOT NULL
    `).all() as (ComicRow & { latest_signature: string | null; latest_checked_at: number | null })[];
    return rows.map(row => ({ ...mapComicRow(row), latest_signature: row.latest_signature, latest_checked_at: row.latest_checked_at }));
}

export function setComicLatestCheck(comicId: number, signature: string | null, checkedAt: number): void {
    db.prepare(`
        UPDATE comics SET latest_signature = COALESCE(?, latest_signature), latest_checked_at = ? WHERE id = ?
    `).run(signature, checkedAt, comicId);
}

// Who to tell about a new page in this comic: subscribers who haven't muted it.
export function getUsersToNotifyForComic(comicId: number): number[] {
    return (db.prepare(`
        SELECT user_id FROM comic_subscriptions WHERE comic_id = ? AND notify_new_pages = 1
    `).all(comicId) as { user_id: number }[]).map(r => r.user_id);
}

// Newest stored pages first - the new-page check resolves "Latest" from
// the first of these that isn't the comic's own (moving-target) homepage.
export function getRecentPages(comicId: number, limit: number): Page[] {
    return db.prepare(`
        SELECT * FROM pages WHERE comic_id = ? ORDER BY page_order DESC LIMIT ?
    `).all(comicId, limit) as Page[];
}
