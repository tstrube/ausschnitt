// Outgoing requests to comic sites identify the app, and requests to the
// same host are spaced out so crawling (read-ahead, the homepage's
// back-walk, new-page checks) never hammers a site.
export const USER_AGENT = 'Ausschnitt (+https://github.com/tstrube/ausschnitt)';

const MIN_GAP_PER_HOST_MS = 500;
const nextSlotByHost = new Map<string, number>();

async function waitForHostSlot(url: string): Promise<void> {
    const host = new URL(url).host;
    const now = Date.now();
    const slot = Math.max(now, nextSlotByHost.get(host) ?? 0);
    nextSlotByHost.set(host, slot + MIN_GAP_PER_HOST_MS);
    if (slot > now) await new Promise(resolve => setTimeout(resolve, slot - now));
}

// fetch() for crawling a comic site: paced per host, with the app's
// User-Agent.
export async function crawlFetch(url: string, init: RequestInit = {}): Promise<Response> {
    await waitForHostSlot(url);
    return fetch(url, { ...init, headers: { 'User-Agent': USER_AGENT, ...init.headers } });
}
