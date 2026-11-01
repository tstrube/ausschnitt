import { User } from './db';

declare global {
    namespace Express {
        interface Request {
            /** Resolved by src/middleware/auth.ts - always set once past the
             * setup/auth guards, so routes past those can assume it exists. */
            user?: User;
        }
    }
}

export {};
