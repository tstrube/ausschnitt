import express, { NextFunction, Request, Response } from 'express';
import compression from 'compression';
import session from 'express-session';
import crypto from 'crypto';
import createError, { HttpError } from 'http-errors';

import * as db from './db';
import { SqliteSessionStore } from './utils/sessionStore';
import * as authRoutes from './routes/auth';
import * as adminRoutes from './routes/admin';
import * as indexRoutes from './routes/index';
import * as addRoutes from './routes/add';
import * as selectRouter from './routes/select';
import * as readerRoutes from './routes/reader';
import * as proxyRoutes from './routes/proxy';
import * as manualRoutes from './routes/manual';
import * as bookmarksRoutes from './routes/bookmarks';
import * as pushRoutes from './routes/push';
import { startNewPageNotifier } from './newPageNotifier';
import { requireSetup, resolveUser } from './middleware/auth';
import { VIEWS_DIR, PUBLIC_DIR, IMAGES_DIR, BOOTSTRAP_CSS_DIR } from './paths';

const app = express();

app.set('views', VIEWS_DIR);
app.set('view engine', 'pug');

app.use(compression());

// Panel images are never rewritten under an existing name (each download
// gets a fresh timestamp-prefixed filename), so they can be cached forever.
app.use('/images', express.static(IMAGES_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(PUBLIC_DIR));
app.use('/vendor/bootstrap', express.static(BOOTSTRAP_CSS_DIR));

app.get('/favicon.ico', (req: Request, res: Response) => res.status(204).end());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Generated once and persisted - a new secret on every restart would log
// everyone out.
let sessionSecret = db.getSetting('session_secret');
if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    db.setSetting('session_secret', sessionSecret);
}

// Only set when a TLS-terminating reverse proxy forwarding X-Forwarded-Proto
// is in front. Without one, trusting X-Forwarded-* would let a client forge
// "https", and a `secure` cookie would never be sent back over plain HTTP.
const behindHttpsProxy = process.env.BEHIND_HTTPS_PROXY === 'true';
if (behindHttpsProxy) {
    app.set('trust proxy', 1);
}

app.use(session({
    secret: sessionSecret,
    store: new SqliteSessionStore(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 30 * 24 * 60 * 60 * 1000,
        secure: behindHttpsProxy,
        // Not sent with requests started by other sites (a form posting
        // here), which blocks cross-site request forgery.
        sameSite: 'lax'
    }
}));

app.use(requireSetup);
app.use(resolveUser);

app.use('/', authRoutes.router);
app.use('/admin', adminRoutes.router);
app.use('/', indexRoutes.router);
app.use('/add', addRoutes.router);
app.use('/select', selectRouter.router);
app.use('/reader', readerRoutes.router);
app.use('/proxy', proxyRoutes.router);
app.use('/manual', manualRoutes.router);
app.use('/bookmarks', bookmarksRoutes.router);
app.use('/push', pushRoutes.router);

// catch 404 and forward to error handler
app.use(function (req: Request, res: Response, next: NextFunction) {
    next(createError(404, `Web page not found: ${req.originalUrl}`));
});

// error handler - must declare all 4 params for Express to treat it as one
app.use(function (err: HttpError, req: Request, res: Response, next: NextFunction) {
    console.error(err);
    const status = err.status || 500;
    res.status(status);
    // 4xx messages are our own, safe-to-show text. Anything else is
    // unexpected and may contain internal details (file paths, library
    // errors), so clients get a generic message; the real one is logged.
    const message = status < 500 ? err.message : 'Something went wrong. Please try again.';
    res.render('error', { url: req.originalUrl, message });
});

startNewPageNotifier();

module.exports = app;
