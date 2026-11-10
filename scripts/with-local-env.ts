// `node scripts/with-local-env.ts <command...>` — runs a command with the local Supabase stack's env.
import { spawn } from 'node:child_process';
import { loadLocalEnv } from './lib/local-env.ts';

loadLocalEnv();
const [cmd, ...args] = process.argv.slice(2);
const child = spawn(cmd, args, { stdio: 'inherit', env: process.env });
child.on('exit', (code) => process.exit(code ?? 0));
