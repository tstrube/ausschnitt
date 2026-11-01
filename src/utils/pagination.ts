export const PAGE_SIZE = 10;

// A `?page=` query value as a 1-based page number, 1 if missing or invalid.
export function parsePageParam(value: unknown): number {
    const page = Number(value);
    return Number.isInteger(page) && page > 0 ? page : 1;
}
