import { Direction, Page, Panel, ReaderComic } from "./types";
import * as db from "./db";
import { fetchAndStorePage, resolveNavUrl, isComicHomeUrl, checkHomepageForNewPage } from "./utils/fetch";

const READ_AHEAD_PAGES = 5;
const READ_AHEAD_END_RECHECK_MS = 3 * 60 * 1000;

/**
 * One cache per (user, comic) pair, so reading position/cursor state never
 * leaks between accounts sharing the same comic.
 */
export class ReaderCache {
    private static sessions = new Map<string, ReaderCache>();

    private comic: ReaderComic | null = null;
    private hasBootstrapped = false;
    private page: Page | null = null;
    private panels: Panel[] = [];
    private currentPanel: Panel | null = null;
    private readAheadRunning = false;
    private readAheadEndedAt = 0;

    private constructor(private readonly userId: number, private readonly comicId: number) {}

    private static key(userId: number, comicId: number): string {
        return `${userId}:${comicId}`;
    }

    public static getInstance(userId: number, comicId: number): ReaderCache {
        const key = this.key(userId, comicId);
        let session = this.sessions.get(key);
        if (!session) {
            session = new ReaderCache(userId, comicId);
            this.sessions.set(key, session);
        }
        return session;
    }

    // Drops one user's in-memory session - for settings/ignore changes that
    // only affect that user's own reading state.
    public static reset(userId: number, comicId: number): void {
        this.sessions.delete(this.key(userId, comicId));
    }

    // Drops *every* subscriber's session for a comic - after a change to the
    // shared cache itself (Clear/Delete).
    public static resetForComic(comicId: number): void {
        const suffix = `:${comicId}`;
        for (const key of this.sessions.keys()) {
            if (key.endsWith(suffix)) this.sessions.delete(key);
        }
    }

    public static resetAll(): void {
        this.sessions.clear();
    }

    // Called after anything that might have downloaded a new page - a no-op
    // unless an admin configured a cap ("max_disk_usage_bytes"; unset/0 =
    // unlimited). Clears the least recently *read* comic
    // (db.touchComicCacheAccess) until under the cap, never the same comic
    // twice in one pass, so a cap below a single comic's size can't loop.
    private static evictOverCapIfNeeded(): void {
        const capRaw = db.getSetting('max_disk_usage_bytes');
        const cap = capRaw ? Number(capRaw) : 0;
        if (!cap) return;

        const cleared: number[] = [];
        while (db.getTotalDiskUsageBytes() > cap) {
            const target = db.getLeastRecentlyAccessedComic(cleared);
            if (!target) break;
            db.clearComicPages(target.id);
            this.resetForComic(target.id);
            cleared.push(target.id);
        }
    }

    async getComic(skipLoadPage = false): Promise<ReaderComic | null> {
        // Always re-read from the DB (a cheap single-row lookup), so selector
        // edits made via /select apply immediately.
        this.comic = db.getReaderComic(this.userId, this.comicId);

        if (!skipLoadPage && !this.hasBootstrapped && this.comic?.last_read_page) {
            this.hasBootstrapped = true;
            await this.getPage(this.comic.last_read_page, true);
        }

        return this.comic;
    }

    async getPage(id: number, skipLoadComic = false): Promise<Page | null> {
        if (!this.page || this.page.id !== id) {
            const page = db.getPage(id);
            if (!page) return null;

            this.page = page;
            this.panels = db.getPanels(page.id);
            this.currentPanel = null;

            if (this.panels.length > 0) {
                const comic = skipLoadComic ? this.comic : await this.getComic(true);
                this.currentPanel =
                    comic?.last_read_page === page.id
                        ? this.panels.find(p => p.id === comic.last_read_panel) ?? this.panels[0]
                        : this.panels[0];
            }
        }
        return this.page;
    }

    getCurrentPanel(): Panel | null {
        return this.currentPanel;
    }

    getFirstPanelOfCurrentPage(): Panel | null {
        if (!this.panels.length) return null;
        this.currentPanel = this.panels[0];
        return this.currentPanel;
    }

    private setPageAndPanels(page: Page, panelIndex: number): Panel | null {
        this.page = page;
        this.panels = db.getPanels(page.id);
        this.currentPanel = this.panels[panelIndex] ?? null;
        return this.currentPanel;
    }

    private async resolveAndLoadPage(direction: Direction, fromPage: Page | null = this.page): Promise<Page | null> {
        if (!this.comic || !fromPage) return null;

        const url = await resolveNavUrl(this.comic, direction, fromPage);
        if (!url) return null;

        let page = db.getPageByUrl(this.comic.id, url);
        if (!page) {
            page = await fetchAndStorePage(url, this.comic, direction, fromPage.id);
            ReaderCache.evictOverCapIfNeeded();
        } else if (direction === 'next' || direction === 'back') {
            this.linkToStoredPage(fromPage, page, direction, url);
        }
        return page;
    }

    // The site's own Next/Back link led to a page that's already stored
    // (where two separately crawled runs meet, e.g. after a Latest jump) -
    // save that link, as fetchAndStorePage does for a new page, so later
    // passes don't re-fetch the site. Skipped for the comic's homepage URL
    // (its stored row is only a snapshot - see stepPage) and when the target
    // is already linked to a *different* page that way (the site's links
    // disagree; keep asking rather than overwrite one with the other).
    private linkToStoredPage(fromPage: Page, page: Page, direction: 'next' | 'back', url: string): void {
        if (!this.comic || page.id === fromPage.id || isComicHomeUrl(url, this.comic.url)) return;
        const backLink = direction === 'next' ? page.prev_id : page.next_id;
        if (backLink !== null && backLink !== fromPage.id) return;
        db.setPageLinkVerified(fromPage.id, page.id, direction);
        // Callers keep using these objects - match the database.
        if (direction === 'next') {
            fromPage.next_id = page.id;
            page.prev_id = fromPage.id;
        } else {
            fromPage.prev_id = page.id;
            page.next_id = fromPage.id;
        }
    }

    // Single next/back page step: the stored link when known, a fresh crawl
    // otherwise. Parameterized by page so the ignored-page skip loop below
    // can repeat it from any page.
    private async stepPage(fromPage: Page, direction: 'next' | 'back'): Promise<Page | null> {
        // A known next_id/prev_id is trusted outright: links are only ever
        // set via setPageLinkVerified, for a link a real next/back crawl
        // confirmed (never derived from page_order adjacency). A live
        // re-check would cost a fetch each time and could never pass for a
        // page whose URL is the comic's own homepage (it always shows
        // whatever's current), stranding a bookmark there.
        const linkedId = direction === 'next' ? fromPage.next_id : fromPage.prev_id;
        if (linkedId) {
            return db.getPage(linkedId);
        }

        // With no next_id, a homepage-anchored page can't be asked for its
        // own "next" link - a moving-target homepage has no "next" relative
        // to itself. A new strip there is detected by comparing the image
        // the homepage shows now against what's stored.
        if (direction === 'next' && this.comic && isComicHomeUrl(fromPage.original_url, this.comic.url)) {
            const newPage = await checkHomepageForNewPage(this.comic, fromPage);
            if (newPage) ReaderCache.evictOverCapIfNeeded();
            return newPage;
        }

        return this.resolveAndLoadPage(direction, fromPage);
    }

    // Steps repeatedly until landing on a page that isn't ignored *by this
    // user*, or there's nothing left in that direction. No length limit -
    // any number of ignored pages in a row is skipped. The only way this
    // could run forever is a cycle in the stored links, which come from the
    // comic's own nav (a site whose newest "Next" wraps around to page 1, or
    // duplicate homepage rows linking to each other); with every page in
    // the cycle ignored, revisiting one means there's nothing to land on.
    // Network use needs no cap of its own: ignored pages have all been
    // downloaded already (you can only ignore what you've seen), so a step
    // that crawls a new page always lands on a non-ignored one and stops.
    private async firstNonIgnoredPage(fromPage: Page, direction: 'next' | 'back'): Promise<Page | null> {
        const visited = new Set<number>([fromPage.id]);
        let candidate: Page | null = fromPage;
        while (true) {
            candidate = await this.stepPage(candidate, direction);
            if (!candidate || visited.has(candidate.id)) return null;
            if (!db.isPageIgnoredByUser(this.userId, candidate.id)) return candidate;
            visited.add(candidate.id);
        }
    }

    // Keeps up to READ_AHEAD_PAGES pages downloaded beyond `fromPageId` in
    // the background, so reading forward doesn't wait for the comic's site.
    // One run at a time per reader; after reaching the end of the comic it
    // waits READ_AHEAD_END_RECHECK_MS before asking the site again. Walks
    // stored links (free) and crawls only where a link is unknown, without
    // touching the cursor.
    readAhead(fromPageId: number): void {
        if (this.readAheadRunning || !this.comic) return;
        if (Date.now() - this.readAheadEndedAt < READ_AHEAD_END_RECHECK_MS) return;
        const fromPage = db.getPage(fromPageId);
        if (!fromPage) return;

        this.readAheadRunning = true;
        (async () => {
            let page: Page = fromPage;
            for (let i = 0; i < READ_AHEAD_PAGES; i++) {
                const next = await this.stepPage(page, 'next');
                if (!next) {
                    this.readAheadEndedAt = Date.now();
                    return;
                }
                page = next;
            }
        })()
            .catch(err => console.warn('Read-ahead failed:', err))
            .finally(() => { this.readAheadRunning = false; });
    }

    // Moves the cursor to a known page/panel (the page's first panel if the
    // panel isn't on it).
    async loadPanel(pageId: number, panelId: number): Promise<Panel | null> {
        const page = db.getPage(pageId);
        if (!page) return null;

        const panels = db.getPanels(page.id);
        const index = panels.findIndex(p => p.id === panelId);
        return this.setPageAndPanels(page, index >= 0 ? index : 0);
    }

    // Loads whatever this user's persisted last-read position is - the
    // "bookmark" - regardless of where the cache is currently looking.
    // First/Latest jumps deliberately don't move the bookmark (see
    // reader.ts), so this is how a jump-away can always be undone.
    async getResumePanel(): Promise<Panel | null> {
        const comic = await this.getComic(true);
        if (!comic?.last_read_page) return null;

        const page = db.getPage(comic.last_read_page);
        if (!page) return null;

        const panels = db.getPanels(page.id);
        const index = panels.findIndex(p => p.id === comic.last_read_panel);
        return this.setPageAndPanels(page, index >= 0 ? index : 0);
    }

    // An ordered window of panels around an anchor - the scroll feed's unit
    // of work, for the initial load and for extending either loaded edge.
    // Walks with getPreviousPanel/getNextPanel (re-seeding at the anchor in
    // between), so it gets the same on-demand crawling and ignored-page
    // skipping as every other nav path. Restores the cursor afterwards:
    // extending the feed must not move it to a panel nobody is looking at.
    async getWindowAround(anchorPageId: number, anchorPanelId: number, before: number, after: number): Promise<Panel[]> {
        const comic = await this.getComic(true);
        if (!comic) return [];

        const savedPage = this.page;
        const savedPanels = this.panels;
        const savedCurrentPanel = this.currentPanel;

        const seedAtAnchor = async (): Promise<Panel | null> => {
            const page = db.getPage(anchorPageId);
            if (!page) return null;
            const panels = db.getPanels(page.id);
            const index = panels.findIndex(p => p.id === anchorPanelId);
            return this.setPageAndPanels(page, index >= 0 ? index : 0);
        };

        try {
            const anchorPanel = await seedAtAnchor();
            if (!anchorPanel) return [];

            const backward: Panel[] = [];
            for (let i = 0; i < before; i++) {
                const p = await this.getPreviousPanel(false);
                if (!p) break;
                backward.unshift(p);
            }

            await seedAtAnchor();
            const forward: Panel[] = [];
            for (let i = 0; i < after; i++) {
                const p = await this.getNextPanel();
                if (!p) break;
                forward.push(p);
            }

            return [...backward, anchorPanel, ...forward];
        } finally {
            this.page = savedPage;
            this.panels = savedPanels;
            this.currentPanel = savedCurrentPanel;
        }
    }

    // The page to resolve First/Latest from: preferably not the comic's
    // homepage, which commonly shows its own "Latest" (sometimes "First")
    // as disabled. Any other stored page has the same site-wide nav.
    private anchorForJump(comic: ReaderComic): Page | null {
        if (this.page && !isComicHomeUrl(this.page.original_url, comic.url)) return this.page;
        const recent = db.getRecentPages(comic.id, 10);
        return recent.find(p => !isComicHomeUrl(p.original_url, comic.url))
            ?? recent[0]
            ?? this.page;
    }

    async getFirstPanel(): Promise<Panel | null> {
        const comic = await this.getComic(true);
        if (!comic) return null;

        if (!this.page) {
            const url = comic.url;
            const existing = db.getPageByUrl(comic.id, url);
            const page = existing ?? await fetchAndStorePage(url, comic, 'first');
            if (!page) return null;
            if (!existing) ReaderCache.evictOverCapIfNeeded();
            return this.setPageAndPanels(page, 0);
        }

        const anchor = this.anchorForJump(comic);
        const page = anchor ? await this.resolveAndLoadPage('first', anchor) : null;
        return page ? this.setPageAndPanels(page, 0) : null;
    }

    async getLastPanel(): Promise<Panel | null> {
        const comic = await this.getComic(true);
        if (!comic) return null;

        const anchor = this.anchorForJump(comic);
        if (!anchor) return null;
        // No Latest link usually means the anchor *is* the newest page -
        // sites disable "Latest" on the latest page itself.
        const url = await resolveNavUrl(comic, 'latest', anchor);
        if (!url) return this.setPageAndPanels(anchor, db.getPanels(anchor.id).length - 1);

        let page = isComicHomeUrl(url, comic.url) ? await this.newestViaHomepage(comic) : null;
        if (!page) {
            page = db.getPageByUrl(comic.id, url);
            if (!page) {
                page = await fetchAndStorePage(url, comic, 'latest', anchor.id);
                ReaderCache.evictOverCapIfNeeded();
            }
        }
        return page ? this.setPageAndPanels(page, db.getPanels(page.id).length - 1) : null;
    }

    // "Latest" pointing at the comic's homepage can't be looked up by URL: a
    // stored homepage row is only a snapshot of whatever it showed when
    // crawled. Walk the next chain from the newest stored permalink to the
    // tip instead - stepPage follows stored links for free and, at a
    // homepage tip, checks the live homepage for anything newer. Null if no
    // permalink is stored yet.
    private async newestViaHomepage(comic: ReaderComic): Promise<Page | null> {
        let page = db.getRecentPages(comic.id, 10).find(p => !isComicHomeUrl(p.original_url, comic.url)) ?? null;
        if (!page) return null;
        for (let i = 0; i < 50; i++) {
            const next = await this.stepPage(page, 'next');
            if (!next || next.id === page.id) break;
            page = next;
        }
        return page;
    }

    // Right after ignoring the current page: jumps past all of its panels
    // to the next page that isn't ignored.
    async skipCurrentPage(): Promise<Panel | null> {
        if (!this.page || !this.comic) return null;
        const nextPage = await this.firstNonIgnoredPage(this.page, 'next');
        return nextPage ? this.setPageAndPanels(nextPage, 0) : null;
    }

    async getNextPanel(): Promise<Panel | null> {
        if (!this.currentPanel || !this.page || !this.comic) return null;

        const index = this.currentPanel.panel_number;
        if (index < this.panels.length - 1) {
            this.currentPanel = this.panels[index + 1];
            return this.currentPanel;
        }

        const nextPage = await this.firstNonIgnoredPage(this.page, 'next');
        return nextPage ? this.setPageAndPanels(nextPage, 0) : null;
    }

    // `useLandingPreference` false = always step to the previous page's
    // last panel - the scroll feed (getWindowAround) needs every panel in
    // order; the first-panel landing preference is for the Back button.
    async getPreviousPanel(useLandingPreference = true): Promise<Panel | null> {
        if (!this.currentPanel || !this.page || !this.comic) return null;

        const index = this.currentPanel.panel_number;
        if (index > 0) {
            this.currentPanel = this.panels[index - 1];
            return this.currentPanel;
        }

        // When crossing into the previous page, land on its first panel
        // instead of its last if the comic is configured that way.
        const landingIndex = (page: Page) => useLandingPreference && this.comic?.start_at_first_panel ? 0 : db.getPanels(page.id).length - 1;

        const prevPage = await this.firstNonIgnoredPage(this.page, 'back');
        return prevPage ? this.setPageAndPanels(prevPage, landingIndex(prevPage)) : null;
    }
}
