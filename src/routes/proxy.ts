import { Router, Request, Response } from 'express';
import { JSDOM } from 'jsdom';
import { isSafeProxyTarget } from '../utils/proxySafety';
import { USER_AGENT } from '../utils/http';

export const router = Router();

// A plain fetch() follows redirects unchecked, so a server that passed
// isSafeProxyTarget could redirect to an internal address. Follow them
// manually instead, validating every hop.
const MAX_REDIRECTS = 5;

class UnsafeProxyTargetError extends Error {}

async function fetchValidated(targetUrl: string): Promise<globalThis.Response> {
    let currentUrl = targetUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!(await isSafeProxyTarget(currentUrl))) {
            throw new UnsafeProxyTargetError(currentUrl);
        }
        const response = await fetch(currentUrl, { redirect: 'manual', headers: { 'User-Agent': USER_AGENT } });
        const location = response.headers.get('location');
        if (response.status >= 300 && response.status < 400 && location) {
            currentUrl = new URL(location, currentUrl).href;
            continue;
        }
        return response;
    }
    throw new Error('Too many redirects');
}

router.get('/', async (req: Request, res: Response) => {
    const targetUrl = req.query.url as string;
    if (!targetUrl) {
        res.status(400).send('Missing url parameter');
        return;
    }

    try {
        const response = await fetchValidated(targetUrl);
        const body = await response.text();

        const dom = new JSDOM(body);
        const document = dom.window.document;
        // Resolve relative links against the last hop, not the requested URL.
        const baseUrl = new URL(response.url || targetUrl);

        const toAbsolute = (value: string) =>
            !value.startsWith('http') && !value.startsWith('//') ? new URL(value, baseUrl).href : value;
        const rewrite = (selector: string, attr: string, skip?: (value: string) => boolean) => {
            document.querySelectorAll(selector).forEach(el => {
                const value = el.getAttribute(attr);
                if (value && !skip?.(value)) el.setAttribute(attr, toAbsolute(value));
            });
        };

        rewrite('link[href]', 'href');
        rewrite('script[src]', 'src');
        rewrite('img[src]', 'src');
        rewrite('a[href]', 'href', href => href.startsWith('#'));
        document.querySelectorAll('[style]').forEach(el => {
            const style = el.getAttribute('style') || '';
            el.setAttribute('style', style.replace(/url\((['"]?)(.*?)\1\)/g, (_match, _quote, url) => `url(${toAbsolute(url)})`));
        });

        res.send(dom.serialize());
    } catch (err) {
        if (err instanceof UnsafeProxyTargetError) {
            res.status(400).send('URL not allowed');
            return;
        }
        console.error(err);
        res.status(500).send('Failed to fetch or parse page');
    }
});
