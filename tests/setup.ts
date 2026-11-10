import { loadLocalEnv } from '../scripts/lib/local-env.ts';

// integration tests need the local Supabase stack (`supabase start`); unit tests ignore it
if (!process.env.VITEST_UNIT_ONLY) loadLocalEnv();
