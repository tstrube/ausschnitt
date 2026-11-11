export interface ComicRow {
    id: number;
    url: string;
    title: string;
    selector_image: string | null;
    selector_next: string | null;
    selector_back: string | null;
    selector_first: string | null;
    selector_latest: string | null;
    reading_direction: string;
}

// Panel order within a page: columns left to right, or right to left.
export type ReadingDirection = 'ltr' | 'rtl';

export interface Comic {
    id: number;
    url: string;
    title: string;
    selector_image: SelectorFingerprint | null;
    selector_next: SelectorFingerprint | null;
    selector_back: SelectorFingerprint | null;
    selector_first: SelectorFingerprint | null;
    selector_latest: SelectorFingerprint | null;
    reading_direction: ReadingDirection;
}

// Per (user, comic) reading state - the comic itself is shared cache, this
// is each account's own (see db.getReaderComic/updateUserComicSettings).
export interface UserComic {
    user_id: number;
    comic_id: number;
    last_read_page: number | null;
    last_read_panel: number | null;
    /** Explicit override; null means "inherit the global default" - see db.getEffectiveReadingMode. */
    reading_mode: string | null;
    /** When going Back across a page boundary, land on that page's first panel instead of its last. */
    start_at_first_panel: boolean;
    /** Hide endless scroll's bottom First/Latest bar; null means "inherit the global default" - see db.getEffectiveHideScrollNav. */
    hide_scroll_nav: boolean | null;
    /** Send new-page notifications for this comic (to devices that enabled them). */
    notify_new_pages: boolean;
    /** Where tapping this comic's notifications goes; null means "the account's default" - see db.getEffectiveNotificationTarget. */
    notification_target: 'resume' | 'latest' | null;
}

// The shared comic merged with one user's reading state - the shape
// ReaderCache and the reader routes work with (db.getReaderComic).
export type ReaderComic = Comic & Pick<UserComic, 'last_read_page' | 'last_read_panel' | 'reading_mode' | 'start_at_first_panel' | 'hide_scroll_nav'>;

export interface SelectorFingerprint {
    selector: string;
    tag: string;
    classes: string[];
    parentTag: string;
    siblingTags: string[];
    text?: string;
}

export interface Page {
    id: number;
    comic_id: number;
    original_url: string;
    prev_id: number | null;
    next_id: number | null;
    page_order: number;
    /** sha256 of the downloaded image bytes, null when unknown. Lets a
     * homepage-anchored page detect a new strip by content (see fetch.ts's
     * checkHomepageForNewPage). */
    image_hash: string | null;
}

export interface Panel {
    id: number;
    page_id: number;
    panel_number: number;
    // NULL while the page is released (every subscriber ignores it) - see
    // db.releasePageImages.
    image_path: string | null;
    // Where the panel sat on its page; NULL for panels stored before boxes
    // were kept.
    box_left: number | null;
    box_top: number | null;
    box_width: number | null;
    box_height: number | null;
}

export type Direction = 'next' | 'back' | 'first' | 'latest';

// A user-named, permanent saved spot - distinct from bookmark_history's
// capped trail of "Save Resume Point" checkpoints. Managed from /bookmarks
// or the reader's 🔖 panel.
export interface Bookmark {
    id: number;
    user_id: number;
    comic_id: number;
    page_id: number;
    panel_id: number;
    name: string;
    created_at: string;
}
