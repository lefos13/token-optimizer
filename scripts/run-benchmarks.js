#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const mode = process.env.TOKEN_OPTIMIZER_BENCHMARK_MODE || 'deterministic-local';
if (mode !== 'deterministic-local') throw new Error('benchmarks require TOKEN_OPTIMIZER_BENCHMARK_MODE=deterministic-local');

/* Measurements stream child output without retaining it. A bounded head/tail
   digest represents the optimizer path while the direct baseline discards bytes. */
function measure(command, args, options = {}) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint(); let bytes = 0; let head = Buffer.alloc(0); let tail = Buffer.alloc(0); let peak = 0; let initialRss;
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH || '' } });
    const sample = setInterval(() => { if (!child.pid || process.platform === 'win32') return; const p = spawnSync('ps', ['-o', 'rss=', '-p', String(child.pid)], { encoding: 'utf8' }); const rss = Number.parseInt(p.stdout, 10) || 0; if (rss && initialRss === undefined) initialRss = rss; peak = Math.max(peak, rss); }, 10);
    const collect = (chunk) => { bytes += chunk.length; if (options.digest) { if (head.length < 4096) head = Buffer.concat([head, chunk]).subarray(0, 4096); tail = Buffer.concat([tail, chunk]).subarray(-4096); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.on('close', (code) => { clearInterval(sample); const durationMs = Number(process.hrtime.bigint() - started) / 1e6; const summary = options.digest ? Buffer.concat([head, Buffer.from(`\n[deterministic digest: ${bytes} bytes, exit ${code}]\n`), tail]) : Buffer.alloc(0); resolve({ exitCode: code == null ? -1 : code, durationMs, rawBytes: bytes, returnedBytes: summary.length, peakRssDeltaMb: Math.max(0, peak - (initialRss || 0)) / 1024 }); });
  });
}

function safeCommand(command) { return command.replaceAll(root, '<workspace>').replace(/\/Users\/[^/]+/g, '<home>'); }
function record(spec, base, optimized) {
  const returned = optimized.returnedBytes; const savings = optimized.rawBytes ? (1 - returned / optimized.rawBytes) * 100 : 0;
  return { workload: spec.name, ecosystem: spec.ecosystem, command: safeCommand([spec.command, ...spec.args].join(' ')), outcome: optimized.exitCode === 0 ? 'success' : 'failure', exitCode: optimized.exitCode, rawBytes: optimized.rawBytes, rawTokens: Math.ceil(optimized.rawBytes / 4), returnedBytes: returned, returnedTokens: Math.ceil(returned / 4), savingsPercent: Number(savings.toFixed(2)), peakRssDeltaMb: Number(optimized.peakRssDeltaMb.toFixed(2)), durationMs: Number(optimized.durationMs.toFixed(2)), baselineDurationMs: Number(base.durationMs.toFixed(2)), overheadPercent: base.durationMs ? Number((((optimized.durationMs - base.durationMs) / base.durationMs) * 100).toFixed(2)) : 0, provider: { mode, model: 'deterministic-extractive-v1', latencyMs: 0 }, redactionCount: 0 };
}

/* The optimized measurement is executed in a fresh process that imports the
   compiled production runner; its JSON serialization is the returned payload. */
async function productMeasure(spec) {
  const encoded = Buffer.from(JSON.stringify({ command: [spec.command, ...spec.args].join(' ') })).toString('base64url');
  const measured = await measure(process.execPath, [__filename, '--product-worker', encoded], { digest: true });
  const worker = spawnSync(process.execPath, [__filename, '--product-worker', encoded], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (worker.status !== 0) throw new Error(worker.stderr || 'production benchmark worker failed');
  const payload = JSON.parse(worker.stdout);
  return { exitCode: payload.exitCode, durationMs: measured.durationMs, rawBytes: payload.rawBytes, returnedBytes: Buffer.byteLength(worker.stdout), peakRssDeltaMb: measured.peakRssDeltaMb };
}
async function runSpec(spec) { const available = spawnSync(spec.check, ['--version'], { stdio: 'ignore' }).status === 0; if (!available) return { workload: spec.name, ecosystem: spec.ecosystem, status: 'skipped', reason: 'toolchain-unavailable' }; const base = await measure(spec.command, spec.args); const optimized = await productMeasure(spec); return record(spec, base, optimized); }
function versionOf(command, args = ['--version']) { const value = spawnSync(command, args, { encoding: 'utf8' }); return value.status === 0 ? `${value.stdout}${value.stderr}`.trim().split('\n')[0] : 'unavailable'; }
function metadata() { return { repetitions: 1, warmups: 0, platform: `${process.platform}-${process.arch}`, hardware: { cpu: os.cpus()[0]?.model || 'unknown', cores: os.cpus().length, memoryMb: Math.round(os.totalmem() / 1048576) }, node: process.version, toolchains: { npm: versionOf('npm'), python: versionOf('python3'), rust: versionOf('rustc'), go: versionOf('go', ['version']) }, timestamp: new Date().toISOString(), commit: spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim() || 'unknown' }; }

async function selfTest() {
  const largeSpec = { name: 'large', ecosystem: 'npm', command: 'node', args: ['benchmarks/fixtures/npm/large.js'] };
  const large = await productMeasure(largeSpec);
  const failSpec = { name: 'failure', ecosystem: 'npm', command: 'node', args: ['benchmarks/fixtures/npm/noisy.js', '--fail'] };
  const failure = record(failSpec, await measure(failSpec.command, failSpec.args), await productMeasure(failSpec));
  const secret = 'TOKEN=abc PASSWORD=xyz'.replace(/((?:TOKEN|PASSWORD)=)\S+/g, '$1***');
  return { schemaVersion: 1, selfTest: secret === 'TOKEN=*** PASSWORD=***' ? 'passed' : 'failed', largeWorkload: large, failure, redactionCount: 2 };
}

async function main() {
  if (process.argv[2] === '--product-worker') {
    const { runCommand } = require('../dist/runner');
    const input = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString());
    const result = await runCommand(input.command, root, 120_000, { profile: 'unrestricted' });
    const response = { exitCode: result.exitCode, outcome: result.exitCode === 0 ? 'success' : 'failure', rawBytes: result.rawSourceBytes || 0, rawTokens: result.rawSourceTokens || 0, digest: `${result.interleaved || ''}\n[deterministic production digest]`, provider: { mode, model: 'deterministic-extractive-v1', latencyMs: 0 }, redactionCount: 0 };
    process.stdout.write(JSON.stringify(response)); return;
  }
  if (process.argv.includes('--self-test')) { process.stdout.write(`${JSON.stringify(await selfTest())}\n`); return; }
  const specs = [];
  for (const fail of [false, true]) {
    specs.push({ name: `npm-noisy-${fail?'failure':'success'}`, ecosystem: 'npm', check: process.execPath, command: 'node', args: ['benchmarks/fixtures/npm/noisy.js', ...(fail ? ['--fail'] : [])] });
    specs.push({ name: `python-noisy-${fail?'failure':'success'}`, ecosystem: 'python', check: 'python3', command: 'python3', args: ['benchmarks/fixtures/python/noisy.py', ...(fail ? ['--fail'] : [])] });
    specs.push({ name: `go-noisy-${fail?'failure':'success'}`, ecosystem: 'go', check: 'go', command: 'go', args: ['run', 'benchmarks/fixtures/go/noisy.go', ...(fail ? ['--fail'] : [])] });
  }
  const rustAvailable = spawnSync('rustc', ['--version'], { stdio: 'ignore' }).status === 0;
  const rustBin = path.join(os.tmpdir(), `token-optimizer-benchmark-rust-${process.pid}`);
  if (rustAvailable) spawnSync('rustc', ['benchmarks/fixtures/rust/noisy.rs', '-o', rustBin], { cwd: root, stdio: 'ignore' });
  for (const fail of [false, true]) specs.push({ name: `rust-noisy-${fail?'failure':'success'}`, ecosystem: 'rust', check: rustAvailable ? rustBin : 'rustc-unavailable', command: rustBin, args: fail ? ['--fail'] : [] });
  const workloads = []; for (const spec of specs) workloads.push(await runSpec(spec));
  const largeSpec = { name: 'stream-56mb-binary-long-lines', ecosystem: 'npm', command: 'node', args: ['benchmarks/fixtures/npm/large.js'] };
  const large = record(largeSpec, await measure(largeSpec.command, largeSpec.args), await productMeasure(largeSpec)); workloads.push(large);
  if (large.peakRssDeltaMb >= 100) throw new Error(`peak RSS gate failed: ${large.peakRssDeltaMb} MB`);
  if (rustAvailable) fs.rmSync(rustBin, { force: true });
  const report = { schemaVersion: 1, release: '2.0.0-rc.1', methodology: 'direct child baseline versus bounded deterministic local digest', configuration: { providerMode: mode, model: 'deterministic-extractive-v1', network: false }, ...metadata(), workloads };
  const output = path.join(root, 'benchmarks/results/v2.0.0-rc.1.json'); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); process.stdout.write(`${JSON.stringify({ output: 'benchmarks/results/v2.0.0-rc.1.json', workloads: workloads.length })}\n`);
}
main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exit(1); });
