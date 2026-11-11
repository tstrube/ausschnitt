import { Router, Request, Response } from 'express';
import * as db from '../db';

export const router = Router();

function subscribedComic(req: Request, res: Response) {
    const comicId = Number(req.params.id);
    const comic = isNaN(comicId) || !db.isUserSubscribed(req.user!.id, comicId) ? null : db.getComic(comicId);
    if (!comic) res.status(404).send('Comic not found');
    return comic;
}

router.get('/:id', (req: Request, res: Response) => {
    const comic = subscribedComic(req, res);
    if (comic) res.render('select', { comic });
});

router.post('/:id', (req: Request, res: Response) => {
    const comic = subscribedComic(req, res);
    if (!comic) return;
    db.updateComicSelectors(comic.id, req.body);
    res.json({ success: true });
});
