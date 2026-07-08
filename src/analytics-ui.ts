import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';

interface AnalyticsRecord {
  toolName: string;
  timestamp: string;
  targetWorkspacePath?: string;
  runId?: string;
  rawLogPath?: string;
  logPath?: string;
  commands?: string[];
  exitCodes?: Record<string, number>;
  rawSourceTokens: number;
  localLlmInputTokens: number;
  localLlmOutputTokens: number;
  localLlmTotalTokens: number;
  returnedToMainTokens: number;
  estimatedTokensSaved: number;
  savingsPercentage: number;
  measurementSource: string;
  llmAvailable?: boolean;
  llmProvider?: string;
  llmModel?: string;
  llmLatencyMs?: number;
  llmTaskType?: string;
  fallbackReason?: string;
  /* Stamped by the UI (not persisted) when records from several workspaces are merged into one feed. */
  sourceWorkspace?: string;
}

interface AnalyticsSummary {
  updatedAt: string;
  totalCalls: number;
  callsByTool: Record<string, number>;
  callsByProvider?: Record<string, number>;
  totalRawSourceTokens: number;
  totalLocalLlmTokens: number;
  totalReturnedToMainTokens: number;
  totalEstimatedMainContextTokensSaved: number;
  averageSavingsPercentage: number;
}

interface WorkspaceLoadResult {
  path: string;
  available: boolean;
  error?: string;
  summary: AnalyticsSummary;
  records: AnalyticsRecord[];
}

interface WorkspaceInfo {
  path: string;
  available: boolean;
  error?: string;
  recordCount: number;
  summary: AnalyticsSummary;
}

interface AnalyticsApiResponse {
  scope: string;
  workspaces: WorkspaceInfo[];
  summary: AnalyticsSummary;
  page: number;
  pageSize: number;
  totalRecords: number;
  totalPages: number;
  records: AnalyticsRecord[];
}

const LOG_DIR = '.codex-local-test-runs';
const DEFAULT_PORT = 8787;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/* Registered workspaces live under a product-specific home directory so the
   dashboard keeps a stable cross-workspace registry without depending on any
   single project checkout. A legacy path is still read for migration. */
const CONFIG_DIR = path.join(os.homedir(), '.token-optimizer-analytics');
const LEGACY_CONFIG_DIR = path.join(os.homedir(), '.local-tester-analytics');
const WORKSPACES_FILE = path.join(CONFIG_DIR, 'workspaces.json');
const LEGACY_WORKSPACES_FILE = path.join(LEGACY_CONFIG_DIR, 'workspaces.json');

function parseArgs(argv: string[]): { seedWorkspaces: string[]; port: number } {
  const seedWorkspaces: string[] = [];
  let port = Number(process.env.PORT || DEFAULT_PORT);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--workspace' || arg === '--store' || arg === '-w') && argv[i + 1]) {
      seedWorkspaces.push(path.resolve(argv[++i]));
    } else if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      port = Number(argv[++i]);
    }
  }

  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }

  return { seedWorkspaces, port };
}

function emptySummary(): AnalyticsSummary {
  return {
    updatedAt: '',
    totalCalls: 0,
    callsByTool: {},
    callsByProvider: {},
    totalRawSourceTokens: 0,
    totalLocalLlmTokens: 0,
    totalReturnedToMainTokens: 0,
    totalEstimatedMainContextTokensSaved: 0,
    averageSavingsPercentage: 0
  };
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/* Registered workspaces persist in the user's home directory so the dashboard
   remembers them across restarts and across the many projects it reports on. */
function loadWorkspaceList(): string[] {
  try {
    const sourceFile = fs.existsSync(WORKSPACES_FILE)
      ? WORKSPACES_FILE
      : LEGACY_WORKSPACES_FILE;
    if (!fs.existsSync(sourceFile)) {
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    if (!Array.isArray(parsed)) {
      return [];
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of parsed) {
      if (typeof entry === 'string' && entry.trim() && !seen.has(entry)) {
        seen.add(entry);
        result.push(entry);
      }
    }
    return result;
  } catch {
    return [];
  }
}

function saveWorkspaceList(workspaces: string[]): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2), 'utf8');
}

function loadWorkspaceAnalytics(workspacePath: string): WorkspaceLoadResult {
  const dir = path.join(workspacePath, LOG_DIR);
  const analyticsPath = path.join(dir, 'analytics.json');
  const summaryPath = path.join(dir, 'analytics-summary.json');

  if (!fs.existsSync(analyticsPath) || !fs.existsSync(summaryPath)) {
    return {
      path: workspacePath,
      available: false,
      error: `Analytics files were not found under ${dir}.`,
      summary: emptySummary(),
      records: []
    };
  }

  try {
    const records = readJson<AnalyticsRecord[]>(analyticsPath);
    const summary = readJson<AnalyticsSummary>(summaryPath);
    return {
      path: workspacePath,
      available: true,
      summary,
      records: Array.isArray(records) ? records : []
    };
  } catch (error: any) {
    return {
      path: workspacePath,
      available: false,
      error: `Failed to read analytics: ${error.message || error}`,
      summary: emptySummary(),
      records: []
    };
  }
}

function clampPageSize(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.floor(value));
}

function clampPage(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.floor(value);
}

function readRequestBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = '';
    let bytes = 0;
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_REQUEST_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (!data.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error('Invalid JSON request body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, statusCode: number, contentType: string, body: string): void {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
  send(res, statusCode, 'application/json; charset=utf-8', JSON.stringify(payload, null, 2));
}

/* Only tool calls with a meaningful raw context (over 1000 tokens) are
   considered for analytical statistics. Small-context calls (e.g. simple
   file reads that the model barely noticed) would dilute the signal. */
const MIN_RAW_TOKENS_FOR_ANALYTICS = 1000;

function meaningfulRecords(records: AnalyticsRecord[]): AnalyticsRecord[] {
  return records.filter((r) => r.rawSourceTokens > MIN_RAW_TOKENS_FOR_ANALYTICS);
}

/* Computes a summary from a filtered record list directly (rather than relying
   on the persisted summary which may include small-context calls). */
function computeSummaryFromRecords(records: AnalyticsRecord[]): AnalyticsSummary {
  const summary = emptySummary();
  if (records.length === 0) return summary;

  summary.updatedAt = records.reduce((latest, r) => r.timestamp > latest ? r.timestamp : latest, '');
  summary.totalCalls = records.length;
  let savingsTotal = 0;

  for (const record of records) {
    summary.callsByTool[record.toolName] = (summary.callsByTool[record.toolName] || 0) + 1;
    const provider = record.llmProvider || 'none';
    if (!summary.callsByProvider) summary.callsByProvider = {};
    summary.callsByProvider[provider] = (summary.callsByProvider[provider] || 0) + 1;
    summary.totalRawSourceTokens += record.rawSourceTokens;
    summary.totalLocalLlmTokens += record.localLlmTotalTokens;
    summary.totalReturnedToMainTokens += record.returnedToMainTokens;
    summary.totalEstimatedMainContextTokensSaved += record.estimatedTokensSaved;
    savingsTotal += record.savingsPercentage;
  }

  summary.averageSavingsPercentage = Number((savingsTotal / records.length).toFixed(4));
  return summary;
}

/* Builds the cross-workspace analytics payload for a given scope ('all' or one
   workspace path), sorted newest-first and paginated. Records with
   rawSourceTokens <= 1000 are excluded from all statistics. */
function buildAnalyticsResponse(
  registered: string[],
  scope: string,
  page: number,
  pageSize: number
): AnalyticsApiResponse {
  const loaded = registered.map(loadWorkspaceAnalytics);

  const targets = scope === 'all' ? loaded : loaded.filter((entry) => entry.path === scope);

  const merged: AnalyticsRecord[] = [];
  for (const entry of targets) {
    if (!entry.available) continue;
    for (const record of meaningfulRecords(entry.records)) {
      merged.push(scope === 'all' ? { ...record, sourceWorkspace: entry.path } : record);
    }
  }
  merged.sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''));

  const totalRecords = merged.length;
  const totalPages = Math.max(1, Math.ceil(totalRecords / pageSize));
  const safePage = Math.min(page, totalPages);
  const start = (safePage - 1) * pageSize;
  const pageRecords = merged.slice(start, start + pageSize);

  /* Recompute summaries from filtered records instead of using the persisted
     summaries (which include small-context calls). */
  const allMeaningful = scope === 'all'
    ? loaded.flatMap((entry) => entry.available ? meaningfulRecords(entry.records) : [])
    : merged;
  const summary = computeSummaryFromRecords(allMeaningful);

  return {
    scope,
    workspaces: loaded.map((entry) => ({
      path: entry.path,
      available: entry.available,
      error: entry.error,
      recordCount: meaningfulRecords(entry.records).length,
      summary: computeSummaryFromRecords(entry.available ? meaningfulRecords(entry.records) : [])
    })),
    summary,
    page: safePage,
    pageSize,
    totalRecords,
    totalPages,
    records: pageRecords
  };
}

/* The dashboard is intentionally shipped as one self-contained HTML document so the compiled dist command can run without bundlers, static asset copying, or extra dependencies. */
function renderHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Token Optimizer Analytics</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --surface: #ffffff;
      --surface-2: #eef2f6;
      --text: #17202a;
      --muted: #627181;
      --border: #d8dee6;
      --accent: #0f766e;
      --accent-2: #1d4ed8;
      --danger: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header {
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    .wrap {
      width: min(1180px, calc(100% - 32px));
      margin: 0 auto;
    }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 18px 0;
      flex-wrap: wrap;
    }
    h1, h2 {
      margin: 0;
      letter-spacing: 0;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
    }
    h2 {
      font-size: 15px;
      font-weight: 700;
      margin-bottom: 10px;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    button {
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 6px;
      color: var(--text);
      cursor: pointer;
      font: inherit;
      padding: 8px 12px;
    }
    button:hover:not(:disabled) { border-color: var(--accent); }
    button:disabled {
      opacity: 0.5;
      cursor: default;
    }
    button.primary {
      background: var(--accent);
      border-color: var(--accent);
      color: #fff;
    }
    button.danger {
      color: var(--danger);
    }
    button.danger:hover { border-color: var(--danger); }
    select, input[type="text"] {
      border: 1px solid var(--border);
      background: var(--surface);
      border-radius: 6px;
      color: var(--text);
      font: inherit;
      padding: 8px 10px;
    }
    main {
      padding: 20px 0 32px;
    }
    .notice {
      display: none;
      border: 1px solid var(--border);
      border-left: 4px solid var(--danger);
      background: var(--surface);
      border-radius: 6px;
      padding: 12px 14px;
      margin-bottom: 16px;
      color: var(--text);
    }
    .panel {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
      margin-bottom: 18px;
    }
    .panel-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .add-row {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }
    .add-row input[type="text"] {
      flex: 1;
      min-width: 240px;
    }
    .workspace-list {
      display: grid;
      gap: 8px;
    }
    .workspace-row {
      display: flex;
      align-items: center;
      gap: 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 8px 12px;
      background: var(--surface-2);
    }
    .workspace-row .ws-path {
      flex: 1;
      overflow-wrap: anywhere;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
    }
    .badge {
      display: inline-block;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 700;
      padding: 2px 9px;
      white-space: nowrap;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .badge.ok {
      background: #ecfdf5;
      color: var(--accent);
      border: 1px solid #b7e4d8;
    }
    .badge.missing {
      background: #fff1f0;
      color: var(--danger);
      border: 1px solid #f3c7c1;
    }
    .provider-local { background: #ecfdf5; color: var(--accent); }
    .provider-gateway { background: #eff6ff; color: var(--accent-2); }
    .model-tag {
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 6px;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 11px;
      padding: 2px 8px;
      color: var(--muted);
      max-width: 260px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: inline-block;
      vertical-align: middle;
    }
    .fallback-tag {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: 6px;
      font-size: 11px;
      padding: 2px 8px;
      color: #92400e;
      max-width: 300px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      display: inline-block;
      vertical-align: middle;
    }
    .scope-row {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 18px;
    }
    .scope-row .meta { white-space: nowrap; }
    .grid {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 14px;
      min-height: 86px;
    }
    .label {
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 8px;
    }
    .value {
      color: var(--text);
      font-size: 24px;
      font-weight: 750;
      line-height: 1.1;
      overflow-wrap: anywhere;
    }
    .section {
      margin-top: 18px;
    }
    .tool-list {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
    }
    .tool-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
    }
    .tool-row span:first-child {
      overflow-wrap: anywhere;
    }
    code {
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    /* The event feed renders each run as a self-contained card so long paths, multi-line commands, and token counts each get their own region instead of being squeezed into narrow table columns. */
    .events {
      display: grid;
      gap: 12px;
    }
    .event {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px 16px;
    }
    .event-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 12px;
      margin-bottom: 12px;
    }
    .event-tool {
      font-size: 15px;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .event-time {
      color: var(--muted);
      font-size: 12px;
    }
    .event-head .spacer { flex: 1; }
    .event-savings {
      color: var(--accent);
      font-size: 15px;
      font-weight: 750;
      white-space: nowrap;
    }
    .source {
      display: inline-block;
      border-radius: 999px;
      background: var(--surface-2);
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      padding: 2px 9px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      white-space: nowrap;
    }
    .event-field {
      display: grid;
      gap: 4px;
      margin-bottom: 12px;
    }
    .field-label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .field-value {
      overflow-wrap: anywhere;
    }
    .field-value code { font-size: 12px; }
    .commands {
      display: grid;
      gap: 6px;
    }
    .command {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: start;
      gap: 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 9px;
      background: var(--surface-2);
    }
    .exit {
      border-radius: 999px;
      background: var(--surface);
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: 11px;
      padding: 1px 7px;
      white-space: nowrap;
    }
    .exit.fail {
      background: #fff1f0;
      border-color: #f3c7c1;
      color: var(--danger);
    }
    .metrics {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      border-top: 1px solid var(--border);
      padding-top: 12px;
    }
    .metric {
      display: grid;
      gap: 2px;
    }
    .metric .m-label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .metric .m-value {
      font-size: 16px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
    }
    .metric.saved .m-value { color: var(--accent); }
    .empty {
      padding: 26px;
      color: var(--muted);
      text-align: center;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .pagination {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-top: 14px;
    }
    .pagination .controls {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    @media (max-width: 900px) {
      .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tool-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 560px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .grid, .tool-list { grid-template-columns: 1fr; }
      .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .wrap { width: min(100% - 20px, 1180px); }
    }
  </style>
</head>
<body>
  <header>
    <div class="wrap topbar">
      <div>
        <h1>Token Optimizer Analytics</h1>
        <div class="meta" id="store">Loading workspaces...</div>
      </div>
      <button type="button" id="refresh">Refresh</button>
    </div>
  </header>
  <main class="wrap">
    <div class="notice" id="notice"></div>

    <section class="panel" aria-label="Registered workspaces">
      <div class="panel-head" id="wsToggle" style="cursor:pointer;user-select:none">
        <h2 style="margin-bottom:0">Workspaces</h2>
        <span style="display:flex;align-items:center;gap:12px">
          <span class="meta" id="workspaceCount"></span>
          <span id="wsChevron" style="font-size:12px;color:var(--muted)">▼</span>
        </span>
      </div>
      <div id="wsBody">
        <form class="add-row" id="addForm">
          <input type="text" id="addInput" placeholder="/absolute/path/to/workspace" autocomplete="off">
          <button type="submit" class="primary">Add workspace</button>
        </form>
        <div class="workspace-list" id="workspaceList" style="margin-top:12px"></div>
      </div>
    </section>

    <div class="scope-row">
      <span class="meta">Viewing</span>
      <select id="scopeSelect"></select>
      <span class="meta" id="scopeMeta"></span>
    </div>

    <section class="grid" aria-label="Analytics summary">
      <div class="card"><div class="label">MCP tool calls</div><div class="value" id="totalCalls">0</div></div>
      <div class="card"><div class="label">Shell commands</div><div class="value" id="commandCount">0</div></div>
      <div class="card"><div class="label">Raw source tokens</div><div class="value" id="rawTokens">0</div></div>
      <div class="card"><div class="label">Token Optimizer tokens</div><div class="value" id="llmTokens">0</div></div>
      <div class="card"><div class="label">Returned main-model tokens</div><div class="value" id="returnedTokens">0</div></div>
      <div class="card"><div class="label">Estimated tokens saved</div><div class="value" id="savedTokens">0</div></div>
      <div class="card"><div class="label">Average savings</div><div class="value" id="avgSavings">0%</div></div>
      <div class="card"><div class="label">Updated</div><div class="value" id="updatedAt">-</div></div>
    </section>
    <section class="section">
      <h2>Calls by Tool</h2>
      <div class="tool-list" id="toolList"></div>
    </section>
    <section class="section">
      <h2>Calls by LLM Provider</h2>
      <div class="tool-list" id="providerList"></div>
    </section>
    <section class="section">
      <h2>Recent Events</h2>
      <div class="events" id="events"></div>
      <div class="pagination" id="pagination">
        <span class="meta" id="pageInfo"></span>
        <div class="controls">
          <label class="meta" for="pageSizeSelect">Per page</label>
          <select id="pageSizeSelect">
            <option value="10">10</option>
            <option value="25" selected>25</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
          <button type="button" id="prevPage">Prev</button>
          <button type="button" id="nextPage">Next</button>
        </div>
      </div>
    </section>
  </main>
  <script>
    const ids = {
      store: document.getElementById('store'),
      notice: document.getElementById('notice'),
      workspaceCount: document.getElementById('workspaceCount'),
      addForm: document.getElementById('addForm'),
      addInput: document.getElementById('addInput'),
      workspaceList: document.getElementById('workspaceList'),
      scopeSelect: document.getElementById('scopeSelect'),
      scopeMeta: document.getElementById('scopeMeta'),
      totalCalls: document.getElementById('totalCalls'),
      commandCount: document.getElementById('commandCount'),
      rawTokens: document.getElementById('rawTokens'),
      llmTokens: document.getElementById('llmTokens'),
      returnedTokens: document.getElementById('returnedTokens'),
      savedTokens: document.getElementById('savedTokens'),
      avgSavings: document.getElementById('avgSavings'),
      updatedAt: document.getElementById('updatedAt'),
      toolList: document.getElementById('toolList'),
      providerList: document.getElementById('providerList'),
      events: document.getElementById('events'),
      pageInfo: document.getElementById('pageInfo'),
      pageSizeSelect: document.getElementById('pageSizeSelect'),
      prevPage: document.getElementById('prevPage'),
      nextPage: document.getElementById('nextPage')
    };

    const state = { scope: 'all', page: 1, pageSize: 25 };

    const fmt = new Intl.NumberFormat();
    const percent = (n) => ((Number(n || 0) * 100).toFixed(1) + '%');
    const num = (n) => fmt.format(Number(n || 0));

    function setText(el, text) {
      el.textContent = text;
    }

    function showNotice(message) {
      if (message) {
        ids.notice.style.display = 'block';
        ids.notice.textContent = message;
      } else {
        ids.notice.style.display = 'none';
        ids.notice.textContent = '';
      }
    }

    function renderTools(callsByTool) {
      ids.toolList.textContent = '';
      const entries = Object.entries(callsByTool || {}).sort((a, b) => b[1] - a[1]);
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No tool calls recorded yet.';
        ids.toolList.appendChild(empty);
        return;
      }
      for (const [tool, count] of entries) {
        const row = document.createElement('div');
        row.className = 'tool-row';
        const name = document.createElement('span');
        name.textContent = tool;
        const value = document.createElement('strong');
        value.textContent = num(count);
        row.append(name, value);
        ids.toolList.appendChild(row);
      }
    }

    function providerLabel(key) {
      if (key === 'local-openai-compatible') return 'Token Optimizer';
      if (key === 'gateway') return 'Gateway';
      if (key === 'none') return 'No LLM (fallback)';
      return key;
    }

    function providerClass(key) {
      if (key === 'local-openai-compatible') return 'provider-local';
      if (key === 'gateway') return 'provider-gateway';
      return '';
    }

    function renderProviders(callsByProvider) {
      ids.providerList.textContent = '';
      const entries = Object.entries(callsByProvider || {}).sort((a, b) => b[1] - a[1]);
      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No provider data recorded yet.';
        ids.providerList.appendChild(empty);
        return;
      }
      for (const [key, count] of entries) {
        const row = document.createElement('div');
        row.className = 'tool-row';
        const name = document.createElement('span');
        const badge = document.createElement('span');
        const cls = providerClass(key);
        badge.className = 'source' + (cls ? ' ' + cls : '');
        badge.textContent = providerLabel(key);
        name.appendChild(badge);
        const value = document.createElement('strong');
        value.textContent = num(count);
        row.append(name, value);
        ids.providerList.appendChild(row);
      }
    }

    function countCommands(records) {
      return (records || []).reduce((sum, record) => {
        return sum + (Array.isArray(record.commands) ? record.commands.length : 0);
      }, 0);
    }

    function buildField(label, valueNode) {
      const field = document.createElement('div');
      field.className = 'event-field';
      const lbl = document.createElement('div');
      lbl.className = 'field-label';
      lbl.textContent = label;
      const val = document.createElement('div');
      val.className = 'field-value';
      val.appendChild(valueNode);
      field.append(lbl, val);
      return field;
    }

    function buildCommands(record) {
      const commands = Array.isArray(record.commands) ? record.commands : [];
      const list = document.createElement('div');
      list.className = 'commands';
      for (const command of commands) {
        const row = document.createElement('div');
        row.className = 'command';
        const code = document.createElement('code');
        code.textContent = command;
        const exit = document.createElement('span');
        const exitCode = record.exitCodes && Object.prototype.hasOwnProperty.call(record.exitCodes, command)
          ? record.exitCodes[command]
          : undefined;
        exit.className = 'exit' + (typeof exitCode === 'number' && exitCode !== 0 ? ' fail' : '');
        exit.textContent = typeof exitCode === 'number' ? 'exit ' + exitCode : 'exit ?';
        row.append(code, exit);
        list.appendChild(row);
      }
      return list;
    }

    function buildMetric(label, value, extraClass) {
      const metric = document.createElement('div');
      metric.className = 'metric' + (extraClass ? ' ' + extraClass : '');
      const mLabel = document.createElement('div');
      mLabel.className = 'm-label';
      mLabel.textContent = label;
      const mValue = document.createElement('div');
      mValue.className = 'm-value';
      mValue.textContent = value;
      metric.append(mLabel, mValue);
      return metric;
    }

    /* Each analytics record is rendered as a card: a header line (tool, time, source, savings), full-width path/run fields that can wrap freely, the command list, and a tabular metrics strip for the token counts. When viewing 'All workspaces' each card also gets a workspace tag so events from different projects stay distinguishable in the merged feed. */
    function renderEvents(records) {
      ids.events.textContent = '';
      if (!records || records.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No analytics records found.';
        ids.events.appendChild(empty);
        return;
      }
      for (const record of records) {
        const card = document.createElement('div');
        card.className = 'event';

        const head = document.createElement('div');
        head.className = 'event-head';
        const tool = document.createElement('span');
        tool.className = 'event-tool';
        tool.textContent = record.toolName;
        const time = document.createElement('span');
        time.className = 'event-time';
        time.textContent = new Date(record.timestamp).toLocaleString();
        const source = document.createElement('span');
        source.className = 'source';
        source.textContent = record.measurementSource;
        const spacer = document.createElement('span');
        spacer.className = 'spacer';
        const savings = document.createElement('span');
        savings.className = 'event-savings';
        savings.textContent = percent(record.savingsPercentage) + ' saved';
        head.append(tool, time, source);
        if (record.llmProvider) {
          const provBadge = document.createElement('span');
          const cls = providerClass(record.llmProvider);
          provBadge.className = 'source' + (cls ? ' ' + cls : '');
          provBadge.textContent = providerLabel(record.llmProvider);
          head.appendChild(provBadge);
        }
        if (record.llmModel) {
          const modelTag = document.createElement('span');
          modelTag.className = 'model-tag';
          modelTag.textContent = record.llmModel;
          modelTag.title = record.llmModel;
          head.appendChild(modelTag);
        }
        if (record.fallbackReason) {
          const fallbackTag = document.createElement('span');
          fallbackTag.className = 'fallback-tag';
          fallbackTag.textContent = 'fallback: ' + record.fallbackReason;
          fallbackTag.title = record.fallbackReason;
          head.appendChild(fallbackTag);
        }
        if (record.sourceWorkspace) {
          const ws = document.createElement('span');
          ws.className = 'source';
          ws.textContent = record.sourceWorkspace;
          head.appendChild(ws);
        }
        head.append(spacer, savings);
        card.appendChild(head);

        if (record.targetWorkspacePath) {
          const code = document.createElement('code');
          code.textContent = record.targetWorkspacePath;
          card.appendChild(buildField('Target workspace', code));
        }

        if (Array.isArray(record.commands) && record.commands.length > 0) {
          card.appendChild(buildField('Commands', buildCommands(record)));
        }

        const runRef = record.runId || record.rawLogPath || record.logPath;
        if (runRef) {
          const code = document.createElement('code');
          code.textContent = runRef;
          card.appendChild(buildField('Run / log', code));
        }

        const metrics = document.createElement('div');
        metrics.className = 'metrics';
        metrics.appendChild(buildMetric('Raw tokens', num(record.rawSourceTokens)));
        metrics.appendChild(buildMetric('Token Optimizer', num(record.localLlmTotalTokens)));
        metrics.appendChild(buildMetric('Returned', num(record.returnedToMainTokens)));
        metrics.appendChild(buildMetric('Saved', num(record.estimatedTokensSaved), 'saved'));
        card.appendChild(metrics);

        ids.events.appendChild(card);
      }
    }

    function renderWorkspaceList(workspaces) {
      ids.workspaceList.textContent = '';
      setText(ids.workspaceCount, workspaces.length + (workspaces.length === 1 ? ' workspace' : ' workspaces'));
      if (workspaces.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No workspaces registered yet. Add an absolute path to a project that has run Token Optimizer tools.';
        ids.workspaceList.appendChild(empty);
        return;
      }
      for (const ws of workspaces) {
        const row = document.createElement('div');
        row.className = 'workspace-row';

        const p = document.createElement('span');
        p.className = 'ws-path';
        p.textContent = ws.path;

        const badge = document.createElement('span');
        badge.className = 'badge ' + (ws.available ? 'ok' : 'missing');
        badge.textContent = ws.available ? num(ws.recordCount) + ' records' : 'no analytics yet';
        if (!ws.available && ws.error) {
          badge.title = ws.error;
        }

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'danger';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => removeWorkspace(ws.path));

        row.append(p, badge, remove);
        ids.workspaceList.appendChild(row);
      }
    }

    function renderScopeOptions(workspaces, totalRecords) {
      const previous = state.scope;
      ids.scopeSelect.textContent = '';

      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = 'All workspaces (' + workspaces.length + ')';
      ids.scopeSelect.appendChild(allOpt);

      for (const ws of workspaces) {
        const opt = document.createElement('option');
        opt.value = ws.path;
        opt.textContent = ws.path;
        ids.scopeSelect.appendChild(opt);
      }

      const stillExists = previous === 'all' || workspaces.some((ws) => ws.path === previous);
      state.scope = stillExists ? previous : 'all';
      ids.scopeSelect.value = state.scope;
      setText(ids.scopeMeta, num(totalRecords) + (totalRecords === 1 ? ' record' : ' records'));
    }

    function renderPagination(payload) {
      state.page = payload.page;
      const start = payload.totalRecords === 0 ? 0 : (payload.page - 1) * payload.pageSize + 1;
      const end = Math.min(payload.totalRecords, payload.page * payload.pageSize);
      setText(ids.pageInfo, payload.totalRecords === 0
        ? 'No records'
        : ('Showing ' + num(start) + '-' + num(end) + ' of ' + num(payload.totalRecords) + ' · page ' + payload.page + ' of ' + payload.totalPages));
      ids.prevPage.disabled = payload.page <= 1;
      ids.nextPage.disabled = payload.page >= payload.totalPages;
    }

    async function fetchWorkspaces() {
      const res = await fetch('/api/workspaces', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load workspaces (HTTP ' + res.status + ')');
      return res.json();
    }

    async function addWorkspace(event) {
      event.preventDefault();
      const value = ids.addInput.value.trim();
      if (!value) return;
      try {
        const res = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: value })
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
        ids.addInput.value = '';
        showNotice('');
        await load();
      } catch (error) {
        showNotice('Could not add workspace: ' + error.message);
      }
    }

    async function removeWorkspace(workspacePath) {
      try {
        const res = await fetch('/api/workspaces', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: workspacePath })
        });
        const payload = await res.json();
        if (!res.ok) throw new Error(payload.error || ('HTTP ' + res.status));
        if (state.scope === workspacePath) {
          state.scope = 'all';
        }
        showNotice('');
        await load();
      } catch (error) {
        showNotice('Could not remove workspace: ' + error.message);
      }
    }

    async function load() {
      const params = new URLSearchParams({
        workspace: state.scope,
        page: String(state.page),
        pageSize: String(state.pageSize)
      });
      const res = await fetch('/api/analytics?' + params.toString(), { cache: 'no-store' });
      const payload = await res.json();
      if (!res.ok) {
        showNotice(payload.error || ('Failed to load analytics (HTTP ' + res.status + ')'));
        return;
      }

      const summary = payload.summary || {};
      const records = payload.records || [];

      setText(ids.store, payload.scope === 'all'
        ? ('Aggregating ' + num((payload.workspaces || []).length) + ' workspace(s)')
        : payload.scope);
      setText(ids.totalCalls, num(summary.totalCalls));
      setText(ids.commandCount, num(countCommands(records)));
      setText(ids.rawTokens, num(summary.totalRawSourceTokens));
      setText(ids.llmTokens, num(summary.totalLocalLlmTokens));
      setText(ids.returnedTokens, num(summary.totalReturnedToMainTokens));
      setText(ids.savedTokens, num(summary.totalEstimatedMainContextTokensSaved));
      setText(ids.avgSavings, percent(summary.averageSavingsPercentage));
      setText(ids.updatedAt, summary.updatedAt ? new Date(summary.updatedAt).toLocaleString() : '-');

      const unavailable = (payload.workspaces || []).filter((ws) => !ws.available);
      if (unavailable.length > 0 && (payload.workspaces || []).length > 0) {
        showNotice(unavailable.length + ' of ' + payload.workspaces.length + ' workspace(s) have no analytics yet (no Token Optimizer tool calls recorded there so far).');
      } else {
        showNotice('');
      }

      renderWorkspaceList(payload.workspaces || []);
      renderScopeOptions(payload.workspaces || [], payload.totalRecords || 0);
      renderTools(summary.callsByTool);
      renderProviders(summary.callsByProvider);
      renderEvents(records);
      renderPagination(payload);
    }

    ids.addForm.addEventListener('submit', addWorkspace);
    ids.scopeSelect.addEventListener('change', () => {
      state.scope = ids.scopeSelect.value;
      state.page = 1;
      load().catch((error) => showNotice('Failed to load analytics: ' + error.message));
    });
    ids.pageSizeSelect.addEventListener('change', () => {
      state.pageSize = Number(ids.pageSizeSelect.value) || 25;
      state.page = 1;
      load().catch((error) => showNotice('Failed to load analytics: ' + error.message));
    });
    ids.prevPage.addEventListener('click', () => {
      if (state.page > 1) {
        state.page -= 1;
        load().catch((error) => showNotice('Failed to load analytics: ' + error.message));
      }
    });
    ids.nextPage.addEventListener('click', () => {
      state.page += 1;
      load().catch((error) => showNotice('Failed to load analytics: ' + error.message));
    });
    document.getElementById('refresh').addEventListener('click', () => {
      load().catch((error) => showNotice('Failed to load analytics: ' + error.message));
    });

    /* Workspace section collapse toggle */
    const wsBody = document.getElementById('wsBody');
    const wsChevron = document.getElementById('wsChevron');
    document.getElementById('wsToggle').addEventListener('click', () => {
      const collapsed = wsBody.style.display === 'none';
      wsBody.style.display = collapsed ? '' : 'none';
      wsChevron.textContent = collapsed ? '▼' : '▶';
    });

    load().catch((error) => {
      showNotice('Failed to load analytics: ' + error.message);
    });
  </script>
</body>
</html>`;
}

function start(): void {
  const { seedWorkspaces, port } = parseArgs(process.argv.slice(2));

  let workspaces = loadWorkspaceList();
  let changed = false;
  for (const seed of seedWorkspaces) {
    if (!workspaces.includes(seed)) {
      workspaces.push(seed);
      changed = true;
    }
  }
  if (workspaces.length === 0) {
    /* No persisted or CLI-provided workspaces yet: seed with the directory the
       command was launched from so the dashboard shows something useful on first run. */
    workspaces.push(process.cwd());
    changed = true;
  }
  if (changed) {
    saveWorkspaceList(workspaces);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

      if (url.pathname === '/') {
        send(res, 200, 'text/html; charset=utf-8', renderHtml());
        return;
      }

      if (url.pathname === '/api/workspaces') {
        if (req.method === 'GET') {
          const registered = loadWorkspaceList();
          const info: WorkspaceInfo[] = registered.map((p) => {
            const loaded = loadWorkspaceAnalytics(p);
            return {
              path: p,
              available: loaded.available,
              error: loaded.error,
              recordCount: loaded.records.length,
              summary: loaded.summary
            };
          });
          sendJson(res, 200, { workspaces: info });
          return;
        }

        if (req.method === 'POST') {
          const body = await readRequestBody(req);
          const raw = typeof body.path === 'string' ? body.path.trim() : '';
          if (!raw) {
            sendJson(res, 400, { error: 'Provide an absolute workspace path in "path".' });
            return;
          }
          const resolved = path.resolve(raw);
          if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            sendJson(res, 400, { error: `Path does not exist or is not a directory: ${resolved}` });
            return;
          }
          const registered = loadWorkspaceList();
          if (!registered.includes(resolved)) {
            registered.push(resolved);
            saveWorkspaceList(registered);
          }
          sendJson(res, 200, { workspaces: registered });
          return;
        }

        if (req.method === 'DELETE') {
          const body = await readRequestBody(req);
          const raw = typeof body.path === 'string' ? body.path.trim() : (url.searchParams.get('path') || '');
          if (!raw) {
            sendJson(res, 400, { error: 'Provide the workspace path to remove in "path".' });
            return;
          }
          const resolved = path.resolve(raw);
          const registered = loadWorkspaceList().filter((p) => p !== resolved);
          saveWorkspaceList(registered);
          sendJson(res, 200, { workspaces: registered });
          return;
        }

        send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed');
        return;
      }

      if (url.pathname === '/api/analytics') {
        const scope = url.searchParams.get('workspace') || 'all';
        const page = clampPage(parseInt(url.searchParams.get('page') || '1', 10));
        const pageSize = clampPageSize(parseInt(url.searchParams.get('pageSize') || String(DEFAULT_PAGE_SIZE), 10));
        const registered = loadWorkspaceList();
        sendJson(res, 200, buildAnalyticsResponse(registered, scope, page, pageSize));
        return;
      }

      send(res, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (error: any) {
      sendJson(res, 500, { error: error.message || String(error) });
    }
  });

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`Analytics UI: http://127.0.0.1:${actualPort}`);
    console.log(`Registered workspaces (${workspaces.length}):`);
    for (const ws of workspaces) {
      console.log(`  - ${ws}`);
    }
    console.log(`Workspace list stored at: ${WORKSPACES_FILE}`);
  });
}

try {
  start();
} catch (error: any) {
  console.error(`Failed to start analytics UI: ${error.message || error}`);
  process.exit(1);
}
