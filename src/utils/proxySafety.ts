import dns from 'dns/promises';
import net from 'net';

function isPrivateOrLoopback(ip: string): boolean {
    if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 127 || a === 10 || a === 0
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 168)
            || (a === 169 && b === 254);
    }

    const lower = ip.toLowerCase();
    return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

/**
 * Blocks the /proxy endpoint from being used to reach loopback/private/link-local
 * addresses (incl. cloud metadata endpoints), resolving DNS first so a hostname
 * can't be used to bypass the check (DNS rebinding).
 */
export async function isSafeProxyTarget(targetUrl: string): Promise<boolean> {
    let parsed: URL;
    try {
        parsed = new URL(targetUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    try {
        const addresses = await dns.lookup(parsed.hostname, { all: true });
        return addresses.length > 0 && addresses.every(({ address }) => !isPrivateOrLoopback(address));
    } catch {
        return false;
    }
}
