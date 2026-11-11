import path from 'path';

// Single source of truth for on-disk locations, resolved relative to this
// file so it's correct from any module under src/ (and dist/).
const PROJECT_ROOT = path.resolve(__dirname, '..');
export const VIEWS_DIR = path.join(PROJECT_ROOT, 'views');
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
// Bootstrap's compiled CSS, served from the installed npm package.
export const BOOTSTRAP_CSS_DIR = path.join(path.dirname(require.resolve('bootstrap/package.json')), 'dist', 'css');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const DB_PATH = path.join(DATA_DIR, 'ausschnitt.db');

// Each comic's panels live in their own subfolder, so per-comic disk usage
// and cleanup work on one directory.
export function imagesDirForComic(comicId: number): string {
    return path.join(IMAGES_DIR, String(comicId));
}
