/**
 * Runs the Vite dev server and the capture API together.
 */
import { spawn } from 'node:child_process';

const children = [];

function run(name, command, args) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ALLOW_PRIVATE: '1' },
    shell: process.platform === 'win32',
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[${name}] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${name}] ${chunk}`));
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) console.error(`[${name}] exited with ${code}`);
  });
  children.push(child);
  return child;
}

run('api', process.execPath, ['server/index.mjs']);
run('web', process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite']);

const shutdown = () => {
  for (const child of children) child.kill('SIGTERM');
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
