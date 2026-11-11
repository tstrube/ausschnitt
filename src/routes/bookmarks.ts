import { Router, Request, Response } from 'express';
import * as db from '../db';
import { formatDateTime } from '../utils/formatDate';
import { PAGE_SIZE, parsePageParam } from '../utils/pagination';

export const router = Router();


// The manager page - every bookmark this user has, across every comic.
router.get('/', (req: Request, res: Response) => {
    const page = parsePageParam(req.query.page);
    res.render('bookmarks', {
        bookmarks: db.getBookmarksPageForUser(req.user!.id, page, PAGE_SIZE),
        page,
        pageSize: PAGE_SIZE,
        formatDateTime
    });
});

router.post('/:id/rename', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    const name = (req.body.name || '').trim();
    if (isNaN(id) || !db.getBookmark(req.user!.id, id)) {
        res.status(404).send('Bookmark not found');
        return;
    }
    if (!name) {
        res.status(400).send('Name is required');
        return;
    }

    db.renameBookmark(req.user!.id, id, name);
    res.redirect(`/bookmarks?page=${parsePageParam(req.query.page)}`);
});

router.post('/:id/delete', (req: Request, res: Response) => {
    const id = Number(req.params.id);
    if (isNaN(id) || !db.getBookmark(req.user!.id, id)) {
        res.status(404).send('Bookmark not found');
        return;
    }

    db.deleteBookmark(req.user!.id, id);
    res.redirect(`/bookmarks?page=${parsePageParam(req.query.page)}`);
});
