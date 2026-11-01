import webpush from 'web-push';
import * as db from './db';
import { Comic } from './types';
import { getComicImageSrc, isComicHomeUrl, resolveNavUrl } from './utils/fetch';

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
// The first check of a comic only records a baseline. A change notifies,
// unless the page it now points at is already stored (someone has already
// read up to it).

const TICK_MS = 5 * 60 * 1000;
const FIRST_TICK_DELAY_MS = 60 * 1000;

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

// Sends to every device this user enabled notifications on. Subscriptions
// the push service reports as gone (the user revoked permission, cleared
// site data, uninstalled the app) are dropped.
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
    return { sent, failed };
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

async function checkComic(comic: Comic & { latest_signature: string | null }): Promise<void> {
    const result = await latestSignature(comic);
    db.setComicLatestCheck(comic.id, result?.signature ?? null, Date.now());
    if (!result || !comic.latest_signature || comic.latest_signature === result.signature) return;
    if (!isComicHomeUrl(result.latestUrl, comic.url) && db.getPageByUrl(comic.id, result.latestUrl)) return;

    console.log(`New page detected for "${comic.title}": ${result.latestUrl}`);
    for (const userId of db.getUsersToNotifyForComic(comic.id)) {
        await sendToUser(userId, {
            title: comic.title,
            body: 'New page available',
            comicId: comic.id,
            tag: `comic-${comic.id}`
        });
    }
}

let running = false;

async function tick(): Promise<void> {
    if (running) return;
    running = true;
    try {
        const hours = db.getNewPageCheckHours();
        if (!hours) return;
        const now = Date.now();
        // One comic at a time - this runs in the background, there's no hurry.
        for (const comic of db.getComicsWatchedForNewPages()) {
            if (comic.latest_checked_at && now - comic.latest_checked_at < hours * 60 * 60 * 1000) continue;
            try {
                await checkComic(comic);
            } catch (err) {
                // Site down, markup changed, ... - try again next interval
                // rather than every tick.
                db.setComicLatestCheck(comic.id, null, Date.now());
                console.error(`New-page check failed for "${comic.title}":`, err);
            }
        }
    } finally {
        running = false;
    }
}

export function startNewPageNotifier(): void {
    setTimeout(tick, FIRST_TICK_DELAY_MS).unref();
    setInterval(tick, TICK_MS).unref();
}
