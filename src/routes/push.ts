import { Router, Request, Response } from 'express';
import * as db from '../db';
import { getVapidPublicKey, sendTestNotification } from '../newPageNotifier';

// Device opt-in for new-page notifications - used by public/js/notifications.js.
export const router = Router();

router.get('/key', (req: Request, res: Response) => {
    res.json({ publicKey: getVapidPublicKey() });
});

router.post('/subscribe', (req: Request, res: Response) => {
    const sub = req.body?.subscription;
    const endpoint = sub?.endpoint;
    const p256dh = sub?.keys?.p256dh;
    const auth = sub?.keys?.auth;
    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string' || !/^https:\/\//.test(endpoint)) {
        res.status(400).json({ error: 'Invalid subscription' });
        return;
    }
    // The address the app is used from - the push "contact" URL (see
    // push_subscriptions in db.ts). Prefer the browser's Origin header:
    // behind a proxy without `trust proxy`, req.protocol says http.
    const origin = req.get('origin') || `${req.protocol}://${req.get('host')}`;
    db.savePushSubscription(req.user!.id, { endpoint, p256dh, auth, origin });
    res.json({ ok: true });
});

router.post('/unsubscribe', (req: Request, res: Response) => {
    if (typeof req.body?.endpoint === 'string') {
        db.deletePushSubscription(req.user!.id, req.body.endpoint);
    }
    res.json({ ok: true });
});

router.post('/test', async (req: Request, res: Response) => {
    res.json(await sendTestNotification(req.user!.id));
});
