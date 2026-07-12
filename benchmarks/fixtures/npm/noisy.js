const fs = require('node:fs');
const failure = process.argv.includes('--fail');
for (let i = 0; i < 4000; i += 1) fs.writeSync(1, `npm fixture line ${i} deterministic output\n`);
fs.writeSync(2, failure ? 'npm fixture intentional failure\n' : 'npm fixture success\n'); process.exitCode = failure ? 7 : 0;
