import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const partner = spawn(process.execPath, [join(root, 'peer.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    PORT: process.env.PARTNER_PORT ?? '4317',
    PARTNER_STATE: process.env.PARTNER_STATE ?? '.local/partner.json',
  },
});
const dispatch = spawn(process.execPath, [join(root, 'dispatch-server.mjs')], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DISPATCH_PORT: process.env.DISPATCH_PORT ?? '4318',
    DISPATCH_STATE: process.env.DISPATCH_STATE ?? '.local/dispatch.json',
    CARRIER_URL: process.env.CARRIER_URL ?? process.env.PARTNER_URL ?? 'http://127.0.0.1:4317',
  },
});

function stop(code) {
  if (!partner.killed) partner.kill('SIGTERM');
  if (!dispatch.killed) dispatch.kill('SIGTERM');
  process.exit(code ?? 0);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
partner.on('exit', code => code && stop(code));
dispatch.on('exit', code => code && stop(code));
