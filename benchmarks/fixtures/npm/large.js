/* One allocation keeps the workload above 50 MB in both process trees while
 * preserving a single exact long line followed by explicit binary bytes. */
const block = Buffer.alloc(56 * 1024 * 1024, 65);
process.stdout.write(block, () => {
  setTimeout(() => process.stdout.write(Buffer.from([0, 255, 10])), 200);
});
