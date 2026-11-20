// New-page notifications through ntfy (https://ntfy.sh): an alternative to
// Web Push that needs neither Google's nor Apple's servers - the ntfy app
// keeps its own connection to an ntfy server (ntfy.sh or self-hosted) and
// shows what's published to a topic. See newPageNotifier.ts.

import { isSafeProxyTarget } from './proxySafety';

export interface NtfyTopic {
    /** The server's base URL, where JSON messages are published. */
    base: string;
    topic: string;
}

// A topic URL as the ntfy app shows it: http(s)://server[/path]/topic -
// the last path segment is the topic (ntfy allows letters, digits, - and _).
export function parseNtfyUrl(raw: unknown): NtfyTopic | null {
    if (typeof raw !== 'string') return null;
    let url: URL;
    try {
        url = new URL(raw.trim());
    } catch {
        return null;
    }
    if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) return null;
    const segments = url.pathname.split('/').filter(Boolean);
    const topic = segments.pop();
    if (!topic || !/^[-_A-Za-z0-9]{1,64}$/.test(topic)) return null;
    return { base: `${url.origin}/${segments.map(s => `${s}/`).join('')}`, topic };
}

// An ntfy server on the local network is the usual self-hosted setup, so an
// account that runs the instance (an admin; in single-user mode, the one
// account) may use any address. Everyone else only public ones - checked
// like /proxy's targets (proxySafety.ts), on saving and again on every
// send - or any account could make the server POST into its network.
export async function isAllowedNtfyUrl(url: string, mayUsePrivate: boolean): Promise<boolean> {
    return mayUsePrivate || isSafeProxyTarget(url);
}

export interface NtfyMessage {
    title: string;
    message: string;
    /** Opened when the notification is tapped. */
    click: string;
}

const NTFY_TIMEOUT_MS = 10_000;

// Published as JSON rather than with ntfy's header form, so titles needn't
// be ASCII. Throws when the server doesn't take it. Redirects aren't
// followed: the address was checked, wherever it would send us wasn't.
export async function sendNtfy(topic: NtfyTopic, token: string | null, message: NtfyMessage): Promise<void> {
    const response = await fetch(topic.base, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ topic: topic.topic, ...message }),
        redirect: 'error',
        signal: AbortSignal.timeout(NTFY_TIMEOUT_MS)
    });
    if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
}
