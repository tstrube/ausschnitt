import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import * as db from '../db';

export const router = Router();

const DEFAULT_SINGLE_USER_USERNAME = 'admin';

// Starts a new session for a freshly-authenticated user (a new session id,
// so one planted before login is worthless), removes expired sessions, and
// sends them to the manual on their own first login - otherwise home.
function loginAs(req: Request, res: Response, user: db.User): void {
    db.pruneExpiredSessions();
    req.session.regenerate(err => {
        if (err) {
            res.status(500).send('Could not start a session');
            return;
        }
        req.session.userId = user.id;
        if (!user.has_seen_intro) {
            db.markIntroSeen(user.id);
            res.redirect('/manual');
            return;
        }
        res.redirect('/');
    });
}

// Failed password attempts per client address: after MAX_FAILED_LOGINS
// within LOGIN_WINDOW_MS, further attempts are refused until the window
// ends. In memory - a restart resets it.
const MAX_FAILED_LOGINS = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const failedLogins = new Map<string, { count: number; since: number }>();

function loginBlocked(ip: string): boolean {
    const entry = failedLogins.get(ip);
    if (!entry) return false;
    if (Date.now() - entry.since > LOGIN_WINDOW_MS) {
        failedLogins.delete(ip);
        return false;
    }
    return entry.count >= MAX_FAILED_LOGINS;
}

function recordFailedLogin(ip: string): void {
    const entry = failedLogins.get(ip);
    if (entry && Date.now() - entry.since <= LOGIN_WINDOW_MS) entry.count++;
    else failedLogins.set(ip, { count: 1, since: Date.now() });
}

router.get('/setup', (req: Request, res: Response) => {
    if (db.hasAnyUser()) {
        res.redirect('/');
        return;
    }
    res.render('setup');
});

router.post('/setup', async (req: Request, res: Response) => {
    if (db.hasAnyUser()) {
        res.redirect('/');
        return;
    }

    const multiUser = !!req.body.multi_user;

    // Single-user: one account without username/password, auto-attached to
    // every request (see resolveUser). Multi-user: every account has both.
    if (!multiUser) {
        const userId = db.createUser(DEFAULT_SINGLE_USER_USERNAME, null, true);
        db.setSetting('multi_user_enabled', 'false');
        const user = db.getUserById(userId)!;
        loginAs(req, res, user);
        return;
    }

    const username = (req.body.username || '').trim();
    const password = req.body.password || '';
    if (!username) {
        res.status(400).render('setup', { error: 'Username is required' });
        return;
    }
    if (!password) {
        res.status(400).render('setup', { error: 'Password is required' });
        return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const userId = db.createUser(username, passwordHash, true);
    db.setSetting('multi_user_enabled', 'true');

    const user = db.getUserById(userId)!;
    loginAs(req, res, user);
});

router.get('/login', (req: Request, res: Response) => {
    const multiUser = db.isMultiUser();
    if (!multiUser) {
        // Nothing to log into - resolveUser auto-attaches the sole user.
        res.redirect('/');
        return;
    }
    if (req.session.userId) {
        res.redirect('/');
        return;
    }

    const pickedUsername = typeof req.query.user === 'string' ? req.query.user : null;

    // Profile picker first, then a password prompt for that account.
    if (!pickedUsername) {
        res.render('profiles', { users: db.listUsers() });
        return;
    }

    res.render('login', { username: pickedUsername });
});

router.post('/login', async (req: Request, res: Response) => {
    const multiUser = db.isMultiUser();
    if (!multiUser) {
        res.redirect('/');
        return;
    }

    const password = req.body.password || '';
    const username = (req.body.username || '').trim();
    const ip = req.ip ?? '';
    if (loginBlocked(ip)) {
        res.status(429).render('login', { error: 'Too many failed attempts. Try again in 15 minutes.', username });
        return;
    }

    const user = db.getUserByUsername(username);
    const valid = user?.password_hash && await bcrypt.compare(password, user.password_hash);
    if (!user || !valid) {
        recordFailedLogin(ip);
        res.status(401).render('login', { error: 'Invalid username or password', username });
        return;
    }

    failedLogins.delete(ip);
    loginAs(req, res, user);
});

router.post('/logout', (req: Request, res: Response) => {
    req.session.destroy(() => res.redirect('/login'));
});
