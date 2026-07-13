import * as path from 'node:path';
import { loadJsonFile, saveJsonFile } from './store';

/* Global, aggregate-only analytics mirroring the client's local context-savings
   accounting. Clients push a sanitized numeric subset of each local analytics
   record; the gateway folds it into counters and per-day buckets and discards
   the record. Nothing user-identifying is accepted or stored: no emails, no
   tokens, no workspace paths, no commands, no log content, no error text. The
   resulting aggregates are safe to expose on the public /stats showcase page. */
export interface SharedAnalyticsRecord {
  toolName: string;
  rawSourceTokens: number;
  returnedToMainTokens: number;
  estimatedTokensSaved: number;
  savingsPercentage: number;
  localLlmTotalTokens: number;
  llmModel?: string;
  llmTaskType?: string;
  llmLatencyMs?: number;
  usedFallback?: boolean;
}

interface DayBucket {
  calls: number;
  tokensSaved: number;
  rawSourceTokens: number;
  savingsSum: number;
}

interface StatsState {
  schemaVersion: number;
  totals: {
    calls: number;
    rawSourceTokens: number;
    returnedToMainTokens: number;
    tokensSaved: number;
    savingsSum: number;
    localLlmTokens: number;
    latencySumMs: number;
    fallbackCalls: number;
  };
  byTool: Record<string, { calls: number; tokensSaved: number; savingsSum: number }>;
  byModel: Record<string, number>;
  days: Record<string, DayBucket>;
}

export interface PublicStats {
  updatedAt: string;
  totalCalls: number;
  totalTokensSaved: number;
  totalRawSourceTokens: number;
  totalReturnedToMainTokens: number;
  totalLocalLlmTokens: number;
  averageSavingsPercentage: number;
  averageLatencyMs: number;
  fallbackRate: number;
  byTool: Record<string, { calls: number; tokensSaved: number; averageSavingsPercentage: number }>;
  byModel: Record<string, number>;
  days: Record<string, { calls: number; tokensSaved: number; averageSavingsPercentage: number }>;
}

export interface StatsStore {
  ingest(raw: unknown): boolean;
  publicStats(): PublicStats;
}

const MAX_MODELS = 50;
const MAX_TOOLS = 50;
const NAME_RE = /^[a-z0-9_]{1,48}$/;
const STATS_SCHEMA_VERSION = 2;
const MIN_SHARED_ANALYTICS_RAW_TOKENS = 1_000;

function emptyState(): StatsState {
  return {
    schemaVersion: STATS_SCHEMA_VERSION,
    totals: {
      calls: 0,
      rawSourceTokens: 0,
      returnedToMainTokens: 0,
      tokensSaved: 0,
      savingsSum: 0,
      localLlmTokens: 0,
      latencySumMs: 0,
      fallbackCalls: 0
    },
    byTool: {},
    byModel: {},
    days: {}
  };
}

function clampNumber(value: unknown, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.min(Math.floor(n), max);
}

/* Whitelist-shaped sanitization: unknown fields are dropped, names are pattern
   checked (else bucketed as "other"), and every number is clamped to a sane
   ceiling so a hostile client cannot inflate the public counters absurdly. */
export function sanitizeSharedRecord(raw: unknown): SharedAnalyticsRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const toolName = typeof r.toolName === 'string' && NAME_RE.test(r.toolName) ? r.toolName : 'other';
  const rawSourceTokens = clampNumber(r.rawSourceTokens, 10_000_000);
  const returnedToMainTokens = clampNumber(r.returnedToMainTokens, 10_000_000);
  const savings = Number(r.savingsPercentage);
  const model = typeof r.llmModel === 'string' ? r.llmModel.slice(0, 80) : undefined;
  const taskType = typeof r.llmTaskType === 'string' && NAME_RE.test(r.llmTaskType) ? r.llmTaskType : undefined;
  return {
    toolName,
    rawSourceTokens,
    returnedToMainTokens,
    estimatedTokensSaved: Math.min(clampNumber(r.estimatedTokensSaved, 10_000_000), rawSourceTokens || 10_000_000),
    savingsPercentage: Number.isFinite(savings) ? Math.min(Math.max(savings, 0), 1) : 0,
    localLlmTotalTokens: clampNumber(r.localLlmTotalTokens, 10_000_000),
    llmModel: model,
    llmTaskType: taskType,
    llmLatencyMs: clampNumber(r.llmLatencyMs, 3_600_000),
    usedFallback: r.usedFallback === true
  };
}

export function createStatsStore(stateDir: string, now: () => number = () => Date.now()): StatsStore {
  const filePath = path.join(stateDir, 'global-stats.json');
  const persisted = loadJsonFile<Partial<StatsState>>(filePath, {});
  const resetLegacyState = persisted.schemaVersion !== STATS_SCHEMA_VERSION;
  const state = resetLegacyState
    ? emptyState()
    : { ...emptyState(), ...persisted } as StatsState;
  state.totals = { ...emptyState().totals, ...state.totals };

  function persist(): void {
    try {
      saveJsonFile(filePath, state);
    } catch {
      /* best-effort persistence */
    }
  }

  /* Statistics are aggregate-only and must remain comparable over time. A
     schema change discards legacy counters before the public portal can serve
     them, while preserving unrelated issued-token state in its own file. */
  if (resetLegacyState) {
    persist();
  }

  return {
    ingest(raw: unknown): boolean {
      const record = sanitizeSharedRecord(raw);
      if (!record) {
        return false;
      }
      /* Small tool calls do not produce a meaningful context-savings signal.
         They are accepted as telemetry no-ops so clients do not retry them. */
      if (record.rawSourceTokens < MIN_SHARED_ANALYTICS_RAW_TOKENS) {
        return true;
      }
      const t = state.totals;
      t.calls += 1;
      t.rawSourceTokens += record.rawSourceTokens;
      t.returnedToMainTokens += record.returnedToMainTokens;
      t.tokensSaved += record.estimatedTokensSaved;
      t.savingsSum += record.savingsPercentage;
      t.localLlmTokens += record.localLlmTotalTokens;
      t.latencySumMs += record.llmLatencyMs || 0;
      if (record.usedFallback) {
        t.fallbackCalls += 1;
      }

      if (state.byTool[record.toolName] || Object.keys(state.byTool).length < MAX_TOOLS) {
        const tool = state.byTool[record.toolName] || { calls: 0, tokensSaved: 0, savingsSum: 0 };
        tool.calls += 1;
        tool.tokensSaved += record.estimatedTokensSaved;
        tool.savingsSum += record.savingsPercentage;
        state.byTool[record.toolName] = tool;
      }
      if (record.llmModel && (state.byModel[record.llmModel] !== undefined || Object.keys(state.byModel).length < MAX_MODELS)) {
        state.byModel[record.llmModel] = (state.byModel[record.llmModel] || 0) + 1;
      }

      const day = new Date(now()).toISOString().slice(0, 10);
      const bucket = state.days[day] || { calls: 0, tokensSaved: 0, rawSourceTokens: 0, savingsSum: 0 };
      bucket.calls += 1;
      bucket.tokensSaved += record.estimatedTokensSaved;
      bucket.rawSourceTokens += record.rawSourceTokens;
      bucket.savingsSum += record.savingsPercentage;
      state.days[day] = bucket;
      persist();
      return true;
    },

    publicStats(): PublicStats {
      const t = state.totals;
      const byTool: PublicStats['byTool'] = {};
      for (const [name, tool] of Object.entries(state.byTool)) {
        byTool[name] = {
          calls: tool.calls,
          tokensSaved: tool.tokensSaved,
          averageSavingsPercentage: tool.calls > 0 ? Number((tool.savingsSum / tool.calls).toFixed(4)) : 0
        };
      }
      const days: PublicStats['days'] = {};
      for (const [day, bucket] of Object.entries(state.days)) {
        days[day] = {
          calls: bucket.calls,
          tokensSaved: bucket.tokensSaved,
          averageSavingsPercentage: bucket.calls > 0 ? Number((bucket.savingsSum / bucket.calls).toFixed(4)) : 0
        };
      }
      return {
        updatedAt: new Date(now()).toISOString(),
        totalCalls: t.calls,
        totalTokensSaved: t.tokensSaved,
        totalRawSourceTokens: t.rawSourceTokens,
        totalReturnedToMainTokens: t.returnedToMainTokens,
        totalLocalLlmTokens: t.localLlmTokens,
        averageSavingsPercentage: t.calls > 0 ? Number((t.savingsSum / t.calls).toFixed(4)) : 0,
        averageLatencyMs: t.calls > 0 ? Math.round(t.latencySumMs / t.calls) : 0,
        fallbackRate: t.calls > 0 ? Number((t.fallbackCalls / t.calls).toFixed(4)) : 0,
        byTool,
        byModel: { ...state.byModel },
        days
      };
    }
  };
}
