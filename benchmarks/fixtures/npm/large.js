const block = Buffer.alloc(1024 * 1024, 65);
for (let i = 0; i < 56; i += 1) process.stdout.write(block);
process.stdout.write(Buffer.from([0, 255, 10]));
