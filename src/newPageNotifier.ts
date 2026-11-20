import webpush from 'web-push';
import * as db from './db';
import { Comic } from './types';
import { getComicImageSrc, isComicHomeUrl, resolveNavUrl } from './utils/fetch';
import { lastOccurrence, serverTimeZone } from './utils/schedule';
import { isAllowedNtfyUrl, parseNtfyUrl, sendNtfy } from './utils/ntfy';

// Background check for new pages, plus the Web Push delivery that tells
// subscribed devices about them (public/sw.js shows the notification).
//
// Detection only *looks* - it never stores pages or touches anyone's
// reading position: tapping the notification opens the reader, which
// crawls the new page the normal way. Each check asks the comic's own
// "Latest" link (resolved from the newest stored page) where the newest
// page is now, and compares that with what it said last time:
// - a permalink (most comics): the URL itself identifies the page;
// - the comic's homepage (a moving target, see fetch.ts's
//   checkHomepageForNewPage): its URL never changes, so the image it's
//   showing identifies the page instead.
//
// Checks run on each account's schedule (weekdays and a time of day in the
// server's time zone, per comic or the account's default -
// utils/schedule.ts). Each
// (account, comic) remembers the "Latest" it was last told about, so
// accounts on different schedules each hear about a new page once. An
// account's first check of a comic only records a baseline. A change
// notifies, unless the page it now points at is already stored (someone
// has already read up to it). Accounts due within a few minutes of each
// other share one look at the comic's site (FRESH_CHECK_MS).

const TICK_MS = 60 * 1000;
const FIRST_TICK_DELAY_MS = 60 * 1000;
// A look at a comic's site this recent is reused rather than repeated.
const FRESH_CHECK_MS = 10 * 60 * 1000;
// A scheduled time missed by more than this (the server was down) is
// skipped rather than run late.
const MAX_LATE_MS = 6 * 60 * 60 * 1000;

// Generated once and kept in settings - new keys would invalidate every
// device's existing subscription.
function vapidKeys(): { publicKey: string; privateKey: string } {
    let publicKey = db.getSetting('vapid_public_key');
    let privateKey = db.getSetting('vapid_private_key');
    if (!publicKey || !privateKey) {
        ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
        db.setSetting('vapid_public_key', publicKey);
        db.setSetting('vapid_private_key', privateKey);
    }
    return { publicKey, privateKey };
}

export function getVapidPublicKey(): string {
    return vapidKeys().publicKey;
}

export interface PushPayload {
    title: string;
    body: string;
    /** Set for new-page notifications - tapping opens this comic (see public/sw.js). */
    comicId?: number;
    tag?: string;
}

// Sends to every device this user enabled notifications on, and to their
// ntfy topic if they set one. Subscriptions the push service reports as
// gone (the user revoked permission, cleared site data, uninstalled the
// app) are dropped.
async function sendToUser(userId: number, payload: PushPayload): Promise<{ sent: number; failed: number }> {
    const { publicKey, privateKey } = vapidKeys();
    let sent = 0;
    let failed = 0;
    for (const sub of db.getPushSubscriptionsForUser(userId)) {
        try {
            await webpush.sendNotification(
                { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                JSON.stringify(payload),
                {
                    vapidDetails: { subject: sub.origin, publicKey, privateKey },
                    TTL: 24 * 60 * 60,
                    // Replaces a still-undelivered earlier notice for the same comic.
                    topic: payload.tag
                }
            );
            sent++;
        } catch (err) {
            failed++;
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
                db.deletePushSubscription(userId, sub.endpoint);
            } else {
                console.error(`Push to user ${userId} failed:`, err);
            }
        }
    }
    if (await sendToNtfy(userId, payload)) sent++;
    else if (db.getUserById(userId)?.ntfy) failed++;
    return { sent, failed };
}

// Whether it went out - false without an ntfy topic too.
async function sendToNtfy(userId: number, payload: PushPayload): Promise<boolean> {
    const user = db.getUserById(userId);
    const topic = user?.ntfy && parseNtfyUrl(user.ntfy.url);
    if (!user?.ntfy || !topic) return false;
    try {
        if (!await isAllowedNtfyUrl(user.ntfy.url, user.is_admin || !db.isMultiUser())) {
            console.error(`ntfy for user ${userId}: ${user.ntfy.url} is not a public address`);
            return false;
        }
        // Same target as tapping a Web Push notification (public/sw.js).
        const click = payload.comicId
            ? `${user.ntfy.origin}/reader/${payload.comicId}/open/notification`
            : `${user.ntfy.origin}/`;
        await sendNtfy(topic, user.ntfy.token, { title: payload.title, message: payload.body, click });
        return true;
    } catch (err) {
        console.error(`ntfy for user ${userId} failed:`, err);
        return false;
    }
}

export function sendTestNotification(userId: number): Promise<{ sent: number; failed: number }> {
    return sendToUser(userId, { title: 'Ausschnitt', body: 'Notifications are working.' });
}

async function latestSignature(comic: Comic): Promise<{ signature: string; latestUrl: string } | null> {
    const recent = db.getRecentPages(comic.id, 10);
    if (!recent.length) return null; // never read - nothing to compare against

    // Same reasoning as ReaderCache.anchorForJump: the homepage often shows
    // its own "Latest" as disabled, any other stored page has the real link.
    const anchor = recent.find(p => !isComicHomeUrl(p.original_url, comic.url)) ?? recent[0];
    // No link usually means the anchor *is* the latest page (Latest
    // disabled on itself).
    const latestUrl = (await resolveNavUrl(comic, 'latest', anchor)) ?? anchor.original_url;

    if (isComicHomeUrl(latestUrl, comic.url)) {
        const src = await getComicImageSrc(comic, latestUrl);
        return src ? { signature: `home:${src}`, latestUrl } : null;
    }
    return { signature: latestUrl, latestUrl };
}

// The comic's "Latest" right now - from a look at its site, or a recent
// enough earlier one. Null if the site couldn't tell.
async function currentSignature(comic: db.ScheduledCheck['comic'], now: number): Promise<{ signature: string; latestUrl: string } | null> {
    if (comic.latest_checked_at && now - comic.latest_checked_at < FRESH_CHECK_MS) {
        if (!comic.latest_signature) return null;
        const homepage = comic.latest_signature.startsWith('home:');
        return { signature: comic.latest_signature, latestUrl: homepage ? comic.url : comic.latest_signature };
    }
    try {
        const result = await latestSignature(comic);
        db.setComicLatestCheck(comic.id, result?.signature ?? null, now);
        comic.latest_signature = result?.signature ?? comic.latest_signature;
        comic.latest_checked_at = now;
        return result;
    } catch (err) {
        // Site down, markup changed, ... - try again at the next scheduled
        // time rather than every tick.
        db.setComicLatestCheck(comic.id, null, now);
        comic.latest_checked_at = now;
        console.error(`New-page check failed for "${comic.title}":`, err);
        return null;
    }
}

// Whether this check found a new page for its account (noted for the home
// page's "New" badge - db.markNewPagesAfter); notifying is up to the caller.
async function runCheck(check: db.ScheduledCheck, now: number): Promise<boolean> {
    const result = await currentSignature(check.comic, now);
    db.setScheduledCheck(check.user_id, check.comic.id, now, result?.signature ?? null);
    if (!result || !check.notified_signature || check.notified_signature === result.signature) return false;
    if (!isComicHomeUrl(result.latestUrl, check.comic.url) && db.getPageByUrl(check.comic.id, result.latestUrl)) return false;

    console.log(`New page detected for "${check.comic.title}": ${result.latestUrl}`);
    db.markNewPagesAfter(check.user_id, check.comic.id, check.notified_signature);
    return true;
}

// The notifications for one account's new comics from one tick: one per
// comic, or - when the account combines them and there are several - one
// for all, whose tap opens the home page with its "New" badges.
async function notifyNewComics(userId: number, comics: Comic[]): Promise<void> {
    const user = db.getUserById(userId);
    if (!user) return;
    if (comics.length > 1 && user.notify_combine) {
        await sendToUser(userId, { title: 'Ausschnitt', body: describeNewComics(comics.map(c => c.title)), tag: 'new-pages' });
        return;
    }
    for (const comic of comics) {
        await sendToUser(userId, { title: comic.title, body: 'New page available', comicId: comic.id, tag: `comic-${comic.id}` });
    }
}

// "QC and PTC have new pages", "QC, PTC and 2 more have new pages".
export function describeNewComics(titles: string[]): string {
    if (titles.length <= 1) return `${titles[0] ?? 'A comic'} has new pages`;
    if (titles.length === 2) return `${titles[0]} and ${titles[1]} have new pages`;
    return `${titles[0]}, ${titles[1]} and ${titles.length - 2} more have new pages`;
}

let running = false;

async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const now = Date.now();
        const timeZone = serverTimeZone();
        // One check at a time - this runs in the background, there's no
        // hurry. Comics are shared, so the same comic object serves every
        // account due for it (currentSignature updates it in place).
        const comics = new Map<number, db.ScheduledCheck['comic']>();
        // New comics per account, notified together once every check ran.
        const newComics = new Map<number, Comic[]>();
        for (const check of db.getScheduledChecks()) {
            check.comic = comics.get(check.comic.id) ?? check.comic;
            comics.set(check.comic.id, check.comic);
            const due = lastOccurrence(check.schedule, timeZone, now);
            if (due === null) continue;
            if (check.notify_checked_at === null) {
                // Newly scheduled: starts with the next scheduled time.
                db.setScheduledCheck(check.user_id, check.comic.id, now, null);
                continue;
            }
            if (check.notify_checked_at >= due) continue;
            if (now - due > MAX_LATE_MS) {
                db.setScheduledCheck(check.user_id, check.comic.id, now, null);
                continue;
            }
            if (await runCheck(check, now)) {
                newComics.set(check.user_id, [...newComics.get(check.user_id) ?? [], check.comic]);
            }
        }
        for (const [userId, comics] of newComics) await notifyNewComics(userId, comics);
    } finally {
        running = false;
    }
}

export function startNewPageNotifier(): void {
    setTimeout(tick, FIRST_TICK_DELAY_MS).unref();
    setInterval(tick, TICK_MS).unref();
}
