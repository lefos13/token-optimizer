const failure = process.argv.includes('--fail');
for (let i = 0; i < 4000; i += 1) process.stdout.write(`npm fixture line ${i} deterministic output\n`);
process.stderr.write(failure ? 'npm fixture intentional failure\n' : 'npm fixture success\n'); process.exit(failure ? 7 : 0);
