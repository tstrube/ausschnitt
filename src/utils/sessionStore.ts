import session from 'express-session';
import * as db from '../db';

// A small express-session Store on the app's own better-sqlite3 connection
// (db.ts's sessions table), so sessions survive restarts without a second
// SQLite driver.
const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Expired sessions are ignored on read; their rows are removed on each
// login (routes/auth.ts's loginAs), the one place new sessions start.
export class SqliteSessionStore extends session.Store {
    get(sid: string, callback: (err: unknown, session?: session.SessionData | null) => void): void {
        try {
            const row = db.getSessionRow(sid);
            if (!row || row.expires_at < Date.now()) {
                callback(null, null);
                return;
            }
            callback(null, JSON.parse(row.session_json));
        } catch (err) {
            callback(err);
        }
    }

    set(sid: string, sessionData: session.SessionData, callback?: (err?: unknown) => void): void {
        try {
            const expiresAt = sessionData.cookie?.expires
                ? new Date(sessionData.cookie.expires).getTime()
                : Date.now() + DEFAULT_MAX_AGE_MS;
            db.setSessionRow(sid, JSON.stringify(sessionData), expiresAt);
            callback?.();
        } catch (err) {
            callback?.(err);
        }
    }

    destroy(sid: string, callback?: (err?: unknown) => void): void {
        try {
            db.destroySessionRow(sid);
            callback?.();
        } catch (err) {
            callback?.(err);
        }
    }

    touch(sid: string, sessionData: session.SessionData, callback?: () => void): void {
        this.set(sid, sessionData, callback);
    }
}
