import { Request, Response, NextFunction } from 'express';
import * as db from '../db';

const PUBLIC_PREFIXES = ['/setup', '/login'];

function isPublicPath(path: string): boolean {
    return PUBLIC_PREFIXES.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}

/**
 * Everything redirects to /setup until the first account exists - the
 * one-time wizard that creates it (see routes/auth.ts).
 */
export function requireSetup(req: Request, res: Response, next: NextFunction): void {
    if (db.hasAnyUser() || isPublicPath(req.path)) {
        next();
        return;
    }
    res.redirect('/setup');
}

/**
 * Resolves req.user for everything past the setup gate. Exactly two modes,
 * nothing in between (enforced when `multi_user_enabled` is written, in
 * routes/auth.ts and routes/admin.ts):
 * - not multi-user: a single account, no username/password ever asked,
 *   silently auto-attached to every request - no login screen at all.
 * - multi-user: every account has a real username+password, a session is
 *   always required, redirect to /login otherwise.
 */
export function resolveUser(req: Request, res: Response, next: NextFunction): void {
    if (isPublicPath(req.path)) {
        next();
        return;
    }

    const multiUser = db.isMultiUser();
    res.locals.showAccountSwitch = multiUser;

    if (!multiUser) {
        req.user = db.listUsers()[0];
        res.locals.user = req.user;
        next();
        return;
    }

    const userId = req.session.userId;
    const user = userId ? db.getUserById(userId) : null;
    if (!user) {
        res.redirect('/login');
        return;
    }

    req.user = user;
    res.locals.user = user;
    next();
}
