import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import * as db from '../db';
import { ReaderCache } from '../readerCache';
import { formatBytes } from '../utils/formatBytes';

export const router = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (!req.user?.is_admin) {
        res.status(403).send('Admin access required');
        return;
    }
    next();
}

router.use(requireAdmin);

function renderUsers(req: Request, res: Response, status: number, error?: string): void {
    const capBytes = Number(db.getSetting('max_disk_usage_bytes') || 0);
    res.status(status).render('admin-users', {
        users: db.listUsers(),
        currentUserId: req.user!.id,
        error,
        totalUsage: formatBytes(db.getTotalDiskUsageBytes()),
        maxDiskUsageMb: capBytes ? Math.round(capBytes / (1024 * 1024)) : ''
    });
}

router.get('/users', (req: Request, res: Response) => {
    renderUsers(req, res, 200);
});

router.post('/users', async (req: Request, res: Response) => {
    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    const isAdmin = !!req.body.is_admin;

    if (!username) {
        renderUsers(req, res, 400, 'Username is required');
        return;
    }
    if (db.getUserByUsername(username)) {
        renderUsers(req, res, 400, 'That username is already taken');
        return;
    }
    if (!password) {
        renderUsers(req, res, 400, 'A password is required - adding a second account makes this a multi-user instance, which requires passwords for everyone');
        return;
    }
    // A second account makes this a multi-user instance, where everyone
    // needs a password - an admin without one would be locked out.
    if (!req.user!.password_hash) {
        renderUsers(req, res, 400, "Set a password on your own account first (below) before adding another user - otherwise you'd be locked out once this becomes multi-user.");
        return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    db.createUser(username, passwordHash, isAdmin);
    db.setSetting('multi_user_enabled', 'true');
    // Single-user mode attached the admin without a session; multi-user
    // requires one from the next request on, so keep them logged in.
    req.session.userId = req.user!.id;
    res.redirect('/admin/users');
});

router.post('/users/:id/password', async (req: Request, res: Response) => {
    const userId = Number(req.params.id);
    const password = req.body.password || '';

    if (isNaN(userId) || !db.getUserById(userId)) {
        res.status(404).send('User not found');
        return;
    }
    if (!password) {
        renderUsers(req, res, 400, 'Password cannot be empty');
        return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    db.setUserPassword(userId, passwordHash);
    res.redirect('/admin/users');
});

router.post('/users/:id/delete', (req: Request, res: Response) => {
    const userId = Number(req.params.id);
    if (userId === req.user!.id) {
        res.status(400).send("You can't delete your own account while logged in as it");
        return;
    }
    if (isNaN(userId) || !db.getUserById(userId)) {
        res.status(404).send('User not found');
        return;
    }
    db.deleteUser(userId);
    ReaderCache.resetAll();
    res.redirect('/admin/users');
});

router.post('/account/password', async (req: Request, res: Response) => {
    const password = req.body.password || '';
    if (!password) {
        renderUsers(req, res, 400, 'Password cannot be empty');
        return;
    }
    const passwordHash = await bcrypt.hash(password, 10);
    db.setUserPassword(req.user!.id, passwordHash);
    res.redirect('/admin/users');
});

// Empty/0 means unlimited (the default). The cap is enforced right after
// each download (see ReaderCache.evictOverCapIfNeeded), not when saved.
router.post('/cache/max-usage', (req: Request, res: Response) => {
    const mb = Number(req.body.max_disk_usage_mb);
    if (req.body.max_disk_usage_mb && (!Number.isFinite(mb) || mb <= 0)) {
        renderUsers(req, res, 400, 'Max disk usage must be a positive number, or blank for unlimited');
        return;
    }
    db.setSetting('max_disk_usage_bytes', mb ? String(Math.round(mb * 1024 * 1024)) : '0');
    res.redirect('/admin/users');
});

// Clears every comic's cache regardless of subscribers - the admin's
// counterpart to "Clear", which multi-user mode hides.
router.post('/cache/clear-now', (req: Request, res: Response) => {
    db.clearAllComicsPages();
    ReaderCache.resetAll();
    res.redirect('/admin/users');
});
