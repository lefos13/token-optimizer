const { spawn } = require('node:child_process');

/* Report the PID only after the grandchild has installed its signal handler.
   Process creation alone is not a readiness boundary: without this handshake,
   SIGTERM can win the race and make the escalation test observe a soft exit. */
const grandchildCode = process.env.IGNORE_TERM
  ? "setTimeout(() => { process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000); }, Number(process.env.READY_DELAY_MS || 0))"
  : "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)";
const grandchild = spawn(process.execPath, ['-e', grandchildCode], {
  stdio: ['ignore', 'pipe', 'ignore'],
});
grandchild.stdout.once('data', () => process.stdout.write(`${grandchild.pid}\n`));
if (process.env.IGNORE_TERM) process.on('SIGTERM', () => {});
setInterval(() => {}, 1000);
