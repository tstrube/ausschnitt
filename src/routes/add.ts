import { Router, Request, Response } from 'express';
import * as db from '../db';
import { USER_AGENT } from '../utils/http';

export const router = Router();

const SCHEME_DETECT_TIMEOUT_MS = 8000;

// Accepts a comic URL with or without "http(s)://": tries https, then http.
// Any HTTP response (even a 404/500) counts as "this scheme works"; only a
// connection-level failure (wrong scheme, DNS, timeout) tries the next.
async function resolveUrlScheme(input: string): Promise<string> {
    const trimmed = input.trim();
    if (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
        return trimmed;
    }

    const bare = trimmed.replace(/^\/+/, '');
    for (const scheme of ['https', 'http']) {
        try {
            await fetch(`${scheme}://${bare}`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(SCHEME_DETECT_TIMEOUT_MS) });
            return `${scheme}://${bare}`;
        } catch {
            // try the next scheme
        }
    }
    // Neither responded - default to https and let the actual crawl surface
    // a clear error during Select Elements, rather than failing silently here.
    return `https://${bare}`;
}

router.get('/', (req: Request, res: Response) => {
    res.render('add');
});

router.post('/', async (req: Request, res: Response) => {
    const title = (req.body.title || '').trim();
    const rawUrl = (req.body.url || '').trim();
    if (!rawUrl) {
        res.status(400).send('Missing comic URL');
        return;
    }

    const url = await resolveUrlScheme(rawUrl);
    const existing = db.getComicByUrl(url);
    const comicId = db.insertComic(url, title, req.user!.id);
    // Already set up by another account (shared cache, same URL) - no need
    // to redo Select Elements.
    res.redirect(existing?.selector_image ? `/reader/${comicId}` : `/select/${comicId}`);
});
