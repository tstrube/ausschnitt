// Year-first, 24-hour, zero-padded - independent of the server's locale.
// Accepts ISO strings and SQLite's datetime('now') format
// ("YYYY-MM-DD HH:MM:SS", UTC without a zone designator).
export function formatDateTime(timestamp: string): string {
    const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(timestamp) ? timestamp : `${timestamp.replace(' ', 'T')}Z`;
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
