#!/usr/bin/env node
const fs = require('node:fs');
const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

const root = path.resolve(__dirname, '..');
const marker = 'TOKEN=***';
const model = 'benchmark-digest-v1';
const mode = process.env.TOKEN_OPTIMIZER_BENCHMARK_MODE || 'deterministic-local';
if (mode !== 'deterministic-local') throw new Error('benchmarks require deterministic-local mode');

function safe(value) {
  return String(value).replaceAll(root, '<workspace>').replace(/\/Users\/[^/]+/g, '<home>');
}

/* RSS sampling walks the complete descendant tree on Unix instead of observing
 * only the immediate shell. Sampling starts at spawn and includes an immediate
 * snapshot to reduce the chance of missing short-lived descendants. */
function treeRssKb(rootPid) {
  if (process.platform === 'win32') return null;
  const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' });
  if (ps.status !== 0) return null;
  const rows = ps.stdout.trim().split(/\n/).map(line => line.trim().split(/\s+/).map(Number));
  const wanted = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of rows) if (wanted.has(ppid) && !wanted.has(pid)) { wanted.add(pid); changed = true; }
  }
  return rows.reduce((sum, [pid, , rss]) => sum + (wanted.has(pid) ? rss : 0), 0);
}

function sampleTree(pid, state) {
  const rss = treeRssKb(pid);
  if (rss !== null) { state.available = true; state.peakKb = Math.max(state.peakKb, rss); }
}

function directMeasure(spec) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const encoded = Buffer.from(JSON.stringify({ command: spec.command, args: spec.args })).toString('base64url');
    const child = spawn(process.execPath, [__filename, '--baseline-worker', encoded], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const state = { peakKb: 0, bytes: 0, available: false };
    const collect = chunk => { state.bytes += chunk.length; };
    const terminate = () => { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} };
    const deadline = setTimeout(terminate, spec.measurementTimeoutMs || 240000);
    child.stdout.on('data', collect); child.stderr.on('data', collect); child.on('error', error => { clearTimeout(deadline); terminate(); reject(error); });
    sampleTree(child.pid, state);
    const timer = setInterval(() => sampleTree(child.pid, state), 2);
    child.on('close', code => {
      sampleTree(child.pid, state); clearInterval(timer); clearTimeout(deadline);
      setImmediate(() => resolve({ exitCode: code ?? -1, rawBytes: state.bytes, peakRssMb: state.available ? state.peakKb / 1024 : null, durationMs: Number(process.hrtime.bigint() - started) / 1e6 }));
    });
  });
}

function startMock(secret, hang = false) {
  const observed = { calls: 0, redactionCount: 0 };
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      if (hang) return;
      const payload = JSON.parse(body);
      if (!Array.isArray(payload.messages)) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ok: true })); return; }
      const prompt = payload.messages.map(item => item.content).join('\n');
      if (prompt.includes(secret) || !prompt.includes(marker)) { response.writeHead(400); response.end('redaction assertion failed'); return; }
      observed.calls += 1; observed.redactionCount = (prompt.match(/TOKEN=\*\*\*/g) || []).length;
      const content = JSON.stringify({ summary: 'Deterministic benchmark digest.', keyFindings: ['Output measured exactly.'], digest: 'benchmark-digest', needsRawLogs: false });
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ model, choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, observed, url: `http://127.0.0.1:${server.address().port}/v1` })));
}

/* Each product measurement owns one mock provider, one compiled MCP server, and
 * one tool call. This prevents a hidden second execution from supplying metrics. */
async function productMeasure(spec) {
  const secret = `bench_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const mock = await startMock(secret, spec.mockHang);
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'token-optimizer-benchmark-'));
  fs.writeFileSync(path.join(configHome, 'config.json'), JSON.stringify({ execution: { profile: 'unrestricted' } }), { mode: 0o600 });
  const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'], cwd: root, stderr: 'pipe', env: {
    PATH: process.env.PATH || '', HOME: process.env.HOME || '', TOKEN_OPTIMIZER_CONFIG_HOME: configHome, LLM_GATEWAY_URL: mock.url, LLM_GATEWAY_TOKEN: 'benchmark-token', LOCAL_LLM_MODEL: 'unused-local'
  }});
  const client = new Client({ name: 'release-benchmark', version: '1.0.0' });
  const state = { peakKb: 0, available: false }; const started = process.hrtime.bigint(); let timer; let callDeadline;
  try {
    await client.connect(transport); sampleTree(transport.pid, state); timer = setInterval(() => sampleTree(transport.pid, state), 2);
    const command = [spec.command, ...spec.args].map(part => JSON.stringify(part)).join(' ');
    const toolCall = client.callTool({ name: 'run_command_digest', arguments: { workspacePath: root, command, intent: `Inspect TOKEN=${secret}`, executionProfile: 'unrestricted', timeoutMs: spec.productTimeoutMs || 180000 } });
    const result = await Promise.race([toolCall, new Promise((_, reject) => { callDeadline = setTimeout(() => reject(Object.assign(new Error('product tool call timed out'), { code: 'BENCHMARK_PRODUCT_TIMEOUT' })), spec.productTimeoutMs || 185000); })]);
    sampleTree(transport.pid, state);
    const output = JSON.parse(result.content[0].text);
    if (mock.observed.calls !== 1) throw new Error(`mock received ${mock.observed.calls} calls`);
    const serializedBytes = Buffer.byteLength(result.content[0].text);
    return { exitCode: output.exitCode, rawBytes: output.rawSourceBytes, returnedBytes: serializedBytes, peakRssMb: state.available ? state.peakKb / 1024 : null,
      durationMs: Number(process.hrtime.bigint() - started) / 1e6, provider: { model: output.llmModel, latencyMs: output.llmLatencyMs }, redaction: output.redactionSummary };
  } finally {
    if (timer) clearInterval(timer); if (callDeadline) clearTimeout(callDeadline); await client.close().catch(() => {}); await transport.close().catch(() => {}); await new Promise(resolve => mock.server.close(resolve)); fs.rmSync(configHome, { recursive: true, force: true });
  }
}

function workloadRecord(spec, baseline, product) {
  if (baseline.exitCode !== product.exitCode) throw new Error(`exit truth mismatch for ${spec.name}: baseline=${baseline.exitCode} product=${JSON.stringify(product)}`);
  if (baseline.rawBytes !== product.rawBytes) throw new Error(`byte count mismatch for ${spec.name}: ${baseline.rawBytes} != ${product.rawBytes}`);
  const savings = product.rawBytes ? (1 - product.returnedBytes / product.rawBytes) * 100 : 0;
  const overhead = baseline.peakRssMb === null || product.peakRssMb === null ? null : product.peakRssMb - baseline.peakRssMb;
  return { workload: spec.name, ecosystem: spec.ecosystem, command: safe([spec.command, ...spec.args].join(' ')), outcome: product.exitCode === 0 ? 'success' : 'failure', exitCode: product.exitCode,
    rawBytes: product.rawBytes, rawTokens: Math.ceil(product.rawBytes / 4), returnedBytes: product.returnedBytes, returnedTokens: Math.ceil(product.returnedBytes / 4),
    savingsPercent: Number(savings.toFixed(2)), rssStatus: overhead === null ? 'unavailable' : 'measured', baselinePeakRssMb: baseline.peakRssMb === null ? null : Number(baseline.peakRssMb.toFixed(2)), productPeakRssMb: product.peakRssMb === null ? null : Number(product.peakRssMb.toFixed(2)),
    productOverheadRssMb: overhead === null ? null : Number(overhead.toFixed(2)), baselineDurationMs: Number(baseline.durationMs.toFixed(2)), durationMs: Number(product.durationMs.toFixed(2)), provider: product.provider, redaction: product.redaction };
}

async function runSpec(spec) {
  if (spawnSync(spec.check, ['--version'], { stdio: 'ignore' }).status !== 0) return { workload: spec.name, ecosystem: spec.ecosystem, status: 'skipped', reason: 'toolchain-unavailable' };
  return workloadRecord(spec, await directMeasure(spec), await productMeasure(spec));
}

function median(values) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; }
function stats(values) { return { median: median(values), min: Math.min(...values), max: Math.max(...values), range: Math.max(...values) - Math.min(...values) }; }
async function runRepeated(spec, repetitions) {
  const samples = [];
  for (let i = 0; i < repetitions; i += 1) samples.push(await runSpec(spec));
  const first = samples[0];
  if (samples.some(sample => sample.exitCode !== first.exitCode || sample.rawBytes !== first.rawBytes)) throw new Error(`BENCHMARK_SAMPLE_INCONSISTENT:${spec.name}`);
  const invariant = { workload: first.workload, ecosystem: first.ecosystem, command: first.command, outcome: first.outcome, exitCode: first.exitCode, rawBytes: first.rawBytes, rawTokens: first.rawTokens, repetitions, samples };
  const duration = stats(samples.map(sample => sample.durationMs)); const baselineDuration = stats(samples.map(sample => sample.baselineDurationMs)); const providerLatency = stats(samples.map(sample => sample.provider.latencyMs));
  if (samples.some(sample => sample.rssStatus !== 'measured')) return { ...invariant, rssStatus: 'unavailable', aggregates: { durationMs: duration, baselineDurationMs: baselineDuration, providerLatencyMs: providerLatency, baselineRssMb: null, productRssMb: null, overheadRssMb: null } };
  return { ...invariant, rssStatus: 'measured', aggregates: { durationMs: duration, baselineDurationMs: baselineDuration, providerLatencyMs: providerLatency, baselineRssMb: stats(samples.map(sample => sample.baselinePeakRssMb)), productRssMb: stats(samples.map(sample => sample.productPeakRssMb)), overheadRssMb: stats(samples.map(sample => sample.productOverheadRssMb)) } };
}

function recursiveFiles(directory, prefix = directory) { return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? recursiveFiles(`${directory}/${entry.name}`, prefix) : [`${directory}/${entry.name}`]); }
function benchmarkInputHash() {
  const files = [...recursiveFiles('dist'), 'scripts/run-benchmarks.js', ...recursiveFiles('benchmarks/fixtures'), 'package.json', 'package-lock.json'].sort();
  const hash = crypto.createHash('sha256'); for (const file of files) hash.update(`${file}\0`).update(fs.readFileSync(path.join(root, file))).update('\0'); return hash.digest('hex');
}
function assertCleanSource() {
  const status = git(['status', '--porcelain', '--untracked-files=all']).split(/\r?\n/).filter(Boolean).filter(line => !line.slice(3).startsWith('benchmarks/results/'));
  if (status.length) { const error = new Error('benchmark source tree is dirty'); error.code = 'BENCHMARK_SOURCE_DIRTY'; throw error; }
}
function provenance() { const lock = require('../package-lock.json'); const declared = lock.packages[''].dependencies; return { benchmarkSourceCommit: git(['rev-parse', 'HEAD']), benchmarkSourceTree: git(['rev-parse', 'HEAD^{tree}']), benchmarkInputHash: benchmarkInputHash(), packageLockHash: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'package-lock.json'))).digest('hex'), dependencyVersions: Object.fromEntries(Object.keys(declared).sort().map(name => [name, lock.packages[`node_modules/${name}`]?.version || 'missing'])) }; }
function verifyProvenance(before, skipClean = false) { if (!skipClean) assertCleanSource(); const after = provenance(); if (JSON.stringify(after) !== JSON.stringify(before)) { const error = new Error('benchmark source changed during measurement'); error.code = 'BENCHMARK_SOURCE_CHANGED'; throw error; } }

async function selfTest() {
  const failureSpec = { name: 'failure', ecosystem: 'npm', check: 'node', command: 'node', args: ['benchmarks/fixtures/npm/noisy.js', '--fail'] };
  const largeSpec = { name: 'binary-long-line', ecosystem: 'npm', check: 'node', command: 'node', args: ['benchmarks/fixtures/npm/large.js'] };
  const failure = await runSpec(failureSpec); const large = await runRepeated(largeSpec, 3); large.expectedBytes = 56 * 1024 * 1024 + 3;
  if (large.rssStatus !== 'measured' || large.rawBytes !== large.expectedBytes || large.aggregates.overheadRssMb.median >= 100) throw new Error(`large workload contract failed: ${JSON.stringify(large)}`);
  return { schemaVersion: 2, selfTest: 'passed', benchmarkInputHash: benchmarkInputHash(), failure, large };
}

function git(args) { const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' }); if (result.status !== 0) throw new Error(result.stderr); return result.stdout.trim(); }
async function main() {
  if (process.argv.includes('--check-clean-fixture')) { const error = new Error('fixture'); error.code = 'BENCHMARK_SOURCE_DIRTY'; throw error; }
  if (process.argv.includes('--source-change-self-test')) { const before = provenance(); before.benchmarkInputHash = '0'.repeat(64); verifyProvenance(before, true); }
  if (process.argv.includes('--cleanup-self-test')) {
    const started = Date.now(); const result = await directMeasure({ command: 'node', args: ['-e', 'setInterval(()=>{},1000)'], measurementTimeoutMs: 50 });
    if (result.exitCode !== -1 || Date.now() - started > 5000) throw new Error('BENCHMARK_CLEANUP_FAILED');
    process.stdout.write('{"cleanup":"passed"}\n'); return;
  }
  if (process.argv.includes('--product-cleanup-self-test')) {
    try { await productMeasure({ command: 'node', args: ['-e', 'console.log(1)'], productTimeoutMs: 50, mockHang: true }); }
    catch (error) { if (error.code === 'BENCHMARK_PRODUCT_TIMEOUT') { process.stdout.write('{"cleanup":"passed"}\n'); return; } throw error; }
    throw new Error('BENCHMARK_PRODUCT_TIMEOUT_EXPECTED');
  }
  if (process.argv[2] === '--baseline-worker') {
    const spec = JSON.parse(Buffer.from(process.argv[3], 'base64url').toString());
    const command = [spec.command, ...spec.args].map(part => JSON.stringify(part)).join(' ');
    const child = spawn(command, { cwd: root, shell: true, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', error => { process.stderr.write(error.message); process.exitCode = 127; });
    child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 128 : 1); });
    return;
  }
  if (process.argv.includes('--self-test')) { process.stdout.write(`${JSON.stringify(await selfTest())}\n`); return; }
  assertCleanSource();
  const before = provenance();
  const specs = [];
  for (const fail of [false, true]) {
    specs.push({ name: `npm-${fail ? 'failure' : 'success'}`, ecosystem: 'npm', check: 'node', command: 'node', args: ['benchmarks/fixtures/npm/noisy.js', ...(fail ? ['--fail'] : [])] });
    specs.push({ name: `python-${fail ? 'failure' : 'success'}`, ecosystem: 'python', check: 'python3', command: 'python3', args: ['benchmarks/fixtures/python/noisy.py', ...(fail ? ['--fail'] : [])] });
    specs.push({ name: `go-${fail ? 'failure' : 'success'}`, ecosystem: 'go', check: 'go', command: 'go', args: ['run', 'benchmarks/fixtures/go/noisy.go', ...(fail ? ['--fail'] : [])] });
  }
  const rustBin = path.join(os.tmpdir(), `token-optimizer-benchmark-rust-${process.pid}`); const rust = spawnSync('rustc', ['benchmarks/fixtures/rust/noisy.rs', '-o', rustBin], { cwd: root });
  for (const fail of [false, true]) specs.push({ name: `rust-${fail ? 'failure' : 'success'}`, ecosystem: 'rust', check: rust.status === 0 ? rustBin : 'rust-unavailable', command: rustBin, args: fail ? ['--fail'] : [] });
  let workloads; let large;
  try {
    workloads = []; for (const spec of specs) workloads.push(await runSpec(spec));
    large = await runRepeated({ name: 'binary-long-line-56mb', ecosystem: 'npm', check: 'node', command: 'node', args: ['benchmarks/fixtures/npm/large.js'] }, 3); workloads.push(large);
    if (large.rssStatus !== 'measured' || large.rawBytes !== 56 * 1024 * 1024 + 3 || large.aggregates.overheadRssMb.median >= 100) throw new Error('large workload release gate failed');
  } finally { fs.rmSync(rustBin, { force: true }); }
  verifyProvenance(before);
  const report = { schemaVersion: 2, release: '2.0.0-rc.5', ...before, timestamp: new Date().toISOString(), platform: `${process.platform}-${process.arch}`,
    methodology: { executionsPerSample: 1, ecosystemWorkloadSamples: 1, releaseGateWorkloadSamples: 3, releaseGateWorkload: 'binary-long-line-56mb', baseline: 'dedicated Node measurement worker plus shell and workload descendants', product: 'compiled MCP server over SDK stdio plus deterministic local OpenAI-compatible HTTP mock', executionConfig: 'fresh temporary user config permits unrestricted execution only for controlled fixture commands and is deleted after each measurement', rss: 'peak aggregate RSS of root process and descendants sampled via ps every 2ms', limitations: process.platform === 'win32' ? ['RSS unavailable on Windows'] : ['Ecosystem workload timing and RSS are single measurements.', 'Very short-lived processes between samples may be missed; RSS is platform-reported and not cross-platform comparable.'] }, workloads };
  const output = path.join(root, 'benchmarks/results/v2.0.0-rc.5.json'); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`); console.log(JSON.stringify({ output: safe(output), workloads: workloads.length }));
}
main().catch(error => { process.stderr.write(`${JSON.stringify({ code: error.code || 'BENCHMARK_FAILED', message: safe(error.message) })}\n`); process.exit(error.code === 'BENCHMARK_SOURCE_DIRTY' ? 2 : 1); });
