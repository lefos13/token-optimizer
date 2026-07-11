const { spawn } = require('node:child_process');

/* Keep both processes alive so the test can verify that group termination reaches descendants. */
const grandchildCode = process.env.IGNORE_TERM
  ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  : 'setInterval(() => {}, 1000)';
const grandchild = spawn(process.execPath, ['-e', grandchildCode], {
  stdio: 'ignore',
});
process.stdout.write(`${grandchild.pid}\n`);
if (process.env.IGNORE_TERM) process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
