// The identity of a comic's URL, for finding a comic another account
// already added: the scheme, a leading "www.", the host's case, a fragment
// and trailing slashes don't make it a different comic. The path's case
// and the query do.
export function comicUrlKey(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return url.trim().replace(/\/+$/, '');
    }
    const host = parsed.host.toLowerCase().replace(/^www\./, '');
    const pathname = parsed.pathname.replace(/\/+$/, '');
    return `${host}${pathname}${parsed.search}`;
}
