// Load .env as early as possible. Import this FIRST in the entrypoint so that
// env vars are available before any module that reads them is evaluated.
import dotenv from 'dotenv';
dotenv.config();
