/**
 * Circuit breaker — runaway/cost guardrail policy (Lane A #6.6b).
 *
 * Claude Code exposes `--max-turns` but NO dollar ceiling, so we enforce one
 * ourselves. This module owns the POLICY only — trip conditions + the
 * steer → constrain → stop escalation ladder. It has no side effects: it reads
 * signals and returns decisions; the caller (the heartbeat beat in index.ts)
 * performs the enforcement (send a corrective message, notify, kill+archive) and
 * emits BreakerState on the separate `control:breakerState` channel (Seam 2 with
 * Oscar/#7, whose avatar adapter gives breaker level precedence over hook status).
 *
 * Inputs aggregate three sources:
 *   (a) Oscar's usage samples via UsageProvider [Seam 1] — for cost + token velocity;
 *   (b) hook events (repeated identical tool calls, api_error storms) — fed in by
 *       HookServer through recordToolUse/recordError;
 *   (c) file-mtime no-progress — passed per-agent by the beat as `progressing`.
 *
 * Velocity is the DIFF of consecutive cumulative samples (Δoutput/Δt), never a
 * single sample treated as an increment.
 *
 * Safe by construction: steer-first, one level per beat (never jump to a kill),
 * de-escalates a level per healthy beat (recovery), and `hardStop` is OFF by
 * default — without it the ladder caps at `constrained` and never kills.
 */
import type { CircuitBreakerConfig } from './config';
import type { AgentUsageSample } from './usage';

export type BreakerLevel = 'healthy' | 'steering' | 'constrained' | 'stopped';

/** Emitted on control:breakerState (Seam 2). One per agent per beat so Oscar's
 *  dashboard/avatars stay live; `level` takes precedence over hook-derived status. */
export interface BreakerState {
  agentId: string;
  level: BreakerLevel;
  reason: string;
  ts: number;
}

/** What the beat should do this tick for one agent. `action` fires only when the
 *  level ESCALATES (so a durable steer message isn't re-sent every beat). */
export type BreakerAction = 'none' | 'steer' | 'constrain' | 'stop';

export interface BreakerDecision {
  state: BreakerState;
  action: BreakerAction;
  /** True when level changed since the previous beat (escalation OR recovery). */
  changed: boolean;
}

/** Per-agent input for one beat. */
export interface BreakerInput {
  agentId: string;
  /** Cumulative usage snapshot, or null when unknown (skips cost/velocity trips). */
  sample: AgentUsageSample | null;
  /** Did the agent make coordination progress recently (file-mtime signal)? */
  progressing: boolean;
}

const LEVELS: BreakerLevel[] = ['healthy', 'steering', 'constrained', 'stopped'];
const rank = (l: BreakerLevel): number => LEVELS.indexOf(l);
const actionFor = (l: BreakerLevel): BreakerAction =>
  l === 'steering' ? 'steer' : l === 'constrained' ? 'constrain' : l === 'stopped' ? 'stop' : 'none';

/** Total tokens in a cumulative sample (all kinds), 0 when unknown. */
const tokensOf = (s: AgentUsageSample | null): number =>
  s ? s.input + s.output + s.cacheRead + s.cacheCreation : 0;

const DEFAULTS = {
  enabled: true,
  hardStop: false,
  repeatedToolLimit: 8,
  errorStormLimit: 5,
  tokenVelocityPerMin: 60_000, // output tokens/min — coarse backstop, deliberately high
  /** Sliding window for the repeat-burst counter. Identical calls spread further
   *  apart than this reset the counter, so legitimate sequential reads across files
   *  (which arrive on the order of seconds, not milliseconds) never accumulate into
   *  a trip even if the same file is occasionally re-read later. Default 60 s. */
  repeatWindowMs: 60_000,
  /** Path patterns (bare basenames, case-insensitive) that are unconditionally
   *  exempt from the repeat-loop counter. Orchestrator inbox- and outbox-polling
   *  reads the same file on every tick by design — they must never trigger a steer.
   *  Matched against the resolved file path of Read/Write/Edit calls. */
  pollPathPatterns: ['inbox.md', 'outbox.md', 'inbox.jsonl', 'outbox.jsonl'] as string[]
};

/** Safety cap on the PreCompact exemption: if PostCompact never arrives (crash,
 *  or a Claude build that doesn't emit it), the Δoutput trips re-arm on their own. */
const COMPACT_GRACE_MS = 5 * 60_000;
/** Trailing grace after PostCompact: the compaction burst lands in the NEXT
 *  beat's cumulative diff, so the exemption must outlive the compaction itself. */
const POST_COMPACT_GRACE_MS = 90_000;
/** How recent a DISTINCT tool call must be to count as progress for the
 *  no-progress arm. Mirrors the beat's file-mtime progress window (300s). */
const PROGRESS_TOOL_WINDOW_MS = 300_000;
/** Consecutive tripping beats the no-progress arm needs before it fires — a
 *  one-beat blip (inbox ack, statusline burst) never steers on its own. */
const NO_PROGRESS_BEATS = 2;

interface AgentBreakerState {
  level: BreakerLevel;
  reason: string;
  lastSample: AgentUsageSample | null;
  /** The key of the most-recent tool call (normalized name + path or truncated input). */
  repeatKey: string | null;
  /** How many *consecutive* times that key has fired within the current burst window. */
  repeatCount: number;
  /** Timestamp of the FIRST call in the current burst window (used to expire the
   *  window and reset the counter when calls are spread across time). */
  repeatWindowStart: number;
  /** Consecutive api_error / retry events with no intervening progress. */
  errorCount: number;
  /** Δoutput-based trips are exempt until this instant (compaction in flight,
   *  set on PreCompact; PostCompact shortens it to a trailing grace). */
  compactingUntil: number;
  /** When the last DISTINCT (name+input) tool call ran. A varied tool stream is
   *  work — background workflows / interactive sessions whose output lands
   *  outside the hive files (git, Jira) must not read as "no progress". A true
   *  single-call loop never refreshes this; an alternating loop that would is
   *  still backstopped by the velocity trip. */
  lastDistinctToolAt: number;
  /** Consecutive beats the no-progress condition held (debounce counter). */
  noProgressBeats: number;
}

export class CircuitBreaker {
  private agents = new Map<string, AgentBreakerState>();

  constructor(private getConfig: () => CircuitBreakerConfig & { costCapUsd?: number; costCapTokens?: number; agentTokenCaps?: Record<string, number> }) {}

  private cfg() {
    const c = this.getConfig() ?? {};
    return {
      enabled: c.enabled ?? DEFAULTS.enabled,
      hardStop: c.hardStop ?? DEFAULTS.hardStop,
      repeatedToolLimit: c.repeatedToolLimit ?? DEFAULTS.repeatedToolLimit,
      errorStormLimit: c.errorStormLimit ?? DEFAULTS.errorStormLimit,
      tokenVelocityPerMin: c.tokenVelocityPerMin ?? DEFAULTS.tokenVelocityPerMin,
      repeatWindowMs: c.repeatWindowMs ?? DEFAULTS.repeatWindowMs,
      pollPathPatterns: c.pollPathPatterns ?? DEFAULTS.pollPathPatterns,
      costCapUsd: c.costCapUsd,
      costCapTokens: c.costCapTokens,
      agentTokenCaps: c.agentTokenCaps
    };
  }

  private get(agentId: string): AgentBreakerState {
    let s = this.agents.get(agentId);
    if (!s) {
      s = {
        level: 'healthy', reason: '', lastSample: null,
        repeatKey: null, repeatCount: 0, repeatWindowStart: 0,
        errorCount: 0, compactingUntil: 0, lastDistinctToolAt: 0, noProgressBeats: 0
      };
      this.agents.set(agentId, s);
    }
    return s;
  }

  /** Drop all state for an agent (call on archive/kill so it can't leak/zombie). */
  forget(agentId: string): void {
    this.agents.delete(agentId);
  }

  /** Current breaker level for an agent (for the live fleet snapshot). */
  levelFor(agentId: string): BreakerLevel {
    return this.agents.get(agentId)?.level ?? 'healthy';
  }

  // ── event-driven inputs (fed by HookServer) ──────────────────────────────

  /** A tool call ran. A NEW (name+path) key counts as forward progress (resets
   *  the repeat + error counters and stamps the distinct-tool clock the
   *  no-progress arm reads); the SAME key within the burst window is the loop
   *  signal. Keys that match the orchestrator-poll exemption list are silently
   *  skipped so routine inbox/outbox syncs never register as erratic behavior. */
  recordToolUse(agentId: string, toolName: string | undefined, toolInput: unknown, now = Date.now()): void {
    const s = this.get(agentId);
    const cfg = this.cfg();

    // Extract the canonical path for file-oriented tools so the key is NOT
    // sensitive to unrelated input fields or serialization differences.
    const resolvedPath = this.resolveToolPath(toolName, toolInput);

    // ── Orchestrator-poll exemption ─────────────────────────────────────────
    // Inbox/outbox reads are mandated background syncs — they intentionally hit
    // the same file every tick. Exempt them before touching any counter so they
    // can never accumulate into a false trip, regardless of frequency.
    if (resolvedPath && this.isPollExempt(resolvedPath, cfg.pollPathPatterns)) return;

    const key = this.toolKey(toolName, resolvedPath, toolInput);

    if (key === s.repeatKey) {
      // ── Per-window burst validation ─────────────────────────────────────────
      // Only count toward the limit when the calls are truly clustered within
      // a tight time window. If the gap since the window opened exceeds
      // repeatWindowMs, this is a new burst — reset the window and start fresh.
      if (now - s.repeatWindowStart > cfg.repeatWindowMs) {
        // Previous burst has aged out: start a new window for this key.
        s.repeatWindowStart = now;
        s.repeatCount = 1;
      } else {
        s.repeatCount += 1;
      }
    } else {
      // Different key → forward progress; reset everything.
      s.repeatKey = key;
      s.repeatCount = 1;
      s.repeatWindowStart = now;
      s.errorCount = 0; // a distinct tool call = progress; clear the error storm
      s.lastDistinctToolAt = now;
    }
  }

  /** An api_error / retry occurred (no forward progress). */
  recordError(agentId: string): void {
    this.get(agentId).errorCount += 1;
  }

  /** Compaction started (PreCompact hook). Exempt the Δoutput-based trips —
   *  compaction burns output tokens while touching no coordination file, which
   *  is exactly the false-positive shape of upstream issue #109 (the harness's
   *  own auto-compact mission tripping its own breaker on idle agents). */
  recordCompactStart(agentId: string, now = Date.now()): void {
    this.get(agentId).compactingUntil = now + COMPACT_GRACE_MS;
  }

  /** Compaction finished (PostCompact, or any SessionStart). Shortens the
   *  exemption to a trailing grace — the burst still lands in the next beat's
   *  cumulative diff. A no-op when no compaction is in flight, so a plain
   *  session start never grants an exemption. */
  recordCompactEnd(agentId: string, now = Date.now()): void {
    const s = this.get(agentId);
    if (s.compactingUntil > now) s.compactingUntil = now + POST_COMPACT_GRACE_MS;
  }

  /**
   * Extract the canonical file path from a file-oriented tool call, or null if
   * the tool is not file-oriented / no path field is present. Supports the common
   * Claude Code tool shapes: `{ path }`, `{ file_path }`, `{ paths: […] }` (the
   * first entry), and the MultiEdit `{ edits: [{ path }] }` array.
   */
  private resolveToolPath(toolName: string | undefined, toolInput: unknown): string | null {
    const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit']);
    if (!toolName || !FILE_TOOLS.has(toolName)) return null;
    if (!toolInput || typeof toolInput !== 'object') return null;
    const inp = toolInput as Record<string, unknown>;
    if (typeof inp['path'] === 'string') return inp['path'];
    if (typeof inp['file_path'] === 'string') return inp['file_path'];
    if (Array.isArray(inp['paths']) && typeof inp['paths'][0] === 'string') return inp['paths'][0];
    if (Array.isArray(inp['edits']) && inp['edits'].length > 0) {
      const first = inp['edits'][0] as Record<string, unknown>;
      if (typeof first['path'] === 'string') return first['path'];
    }
    return null;
  }

  /**
   * Return true when a resolved file path matches one of the orchestrator-poll
   * exemption patterns. Patterns are compared against the BASENAME of the path,
   * case-insensitively. This keeps the exemption narrowly scoped (no accidental
   * broad wildcards) while covering every hive-root layout variation.
   */
  private isPollExempt(resolvedPath: string, patterns: string[]): boolean {
    // Derive the basename without pulling in `node:path` at module level —
    // the breaker is a pure-policy module with no fs or path imports.
    const base = resolvedPath.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    return patterns.some((p) => base === p.toLowerCase());
  }

  private toolKey(toolName: string | undefined, resolvedPath: string | null, toolInput: unknown): string {
    // For file-oriented tools we already have the canonical path — use it
    // directly so the key is unambiguous and allocation-free for large writes.
    if (resolvedPath !== null) {
      return `${toolName ?? '?'}:${resolvedPath}`;
    }
    // For all other tools: truncating serialization (the original approach).
    // Capping each string field bounds the synchronous work on the hook path
    // while keeping key semantics (same call → same key within 200 chars).
    let inp = '';
    try {
      inp = JSON.stringify(toolInput, (_k, v) =>
        typeof v === 'string' && v.length > 250 ? v.slice(0, 250) : v) ?? '';
    } catch { inp = String(toolInput); }
    return `${toolName ?? '?'}:${inp.slice(0, 200)}`;
  }

  // ── periodic evaluation (called by the heartbeat beat) ────────────────────

  /** Evaluate every agent for this beat and return a decision per agent. The
   *  caller emits each state (keeps the dashboard live) and enforces `action`
   *  when present. */
  tick(inputs: BreakerInput[], nowMs: number): BreakerDecision[] {
    const cfg = this.cfg();
    const decisions: BreakerDecision[] = [];
    if (!cfg.enabled) {
      // Breaker off: report healthy for everyone, take no action.
      for (const { agentId } of inputs) {
        const s = this.get(agentId);
        const changed = s.level !== 'healthy';
        s.level = 'healthy'; s.reason = '';
        decisions.push({ state: { agentId, level: 'healthy', reason: '', ts: nowMs }, action: 'none', changed });
      }
      return decisions;
    }

    // Cost cap is floor-wide: sum cumulative usd, blame the single biggest spender
    // so one runaway doesn't trip the whole floor.
    let topSpender: string | null = null;
    if (typeof cfg.costCapUsd === 'number' && cfg.costCapUsd > 0) {
      let total = 0; let max = -1;
      for (const i of inputs) {
        const usd = i.sample?.usd ?? 0;
        total += usd;
        if (usd > max) { max = usd; topSpender = i.agentId; }
      }
      if (total <= cfg.costCapUsd) topSpender = null; // under cap — nobody blamed
    }

    // Token cap (the user-facing budget): same floor-wide logic on total tokens.
    let topTokenSpender: string | null = null;
    if (typeof cfg.costCapTokens === 'number' && cfg.costCapTokens > 0) {
      let total = 0; let max = -1;
      for (const i of inputs) {
        const tok = tokensOf(i.sample);
        total += tok;
        if (tok > max) { max = tok; topTokenSpender = i.agentId; }
      }
      if (total <= cfg.costCapTokens) topTokenSpender = null; // under cap
    }

    for (const input of inputs) {
      const s = this.get(input.agentId);
      const trip = this.evaluate(
        input, s, cfg, nowMs,
        input.agentId === topSpender, cfg.costCapUsd,
        input.agentId === topTokenSpender, cfg.costCapTokens
      );
      // remember the cumulative baseline for next beat's velocity diff
      if (input.sample) s.lastSample = input.sample;

      const ceiling: BreakerLevel = cfg.hardStop ? 'stopped' : 'constrained';
      let target = s.level;
      if (trip.tripping) {
        target = LEVELS[Math.min(rank(s.level) + 1, rank(ceiling))];
      } else {
        target = LEVELS[Math.max(rank(s.level) - 1, 0)]; // recover one level
      }
      const changed = target !== s.level;
      const escalated = rank(target) > rank(s.level);
      s.level = target;
      s.reason = trip.tripping ? trip.reason : (changed ? 'recovering — signals cleared' : s.reason);

      decisions.push({
        state: { agentId: input.agentId, level: target, reason: s.reason, ts: nowMs },
        action: escalated ? actionFor(target) : 'none',
        changed
      });
    }
    return decisions;
  }

  /** Pure trip evaluation for one agent given its signals + remembered baseline. */
  private evaluate(
    input: BreakerInput,
    s: AgentBreakerState,
    cfg: ReturnType<CircuitBreaker['cfg']>,
    nowMs: number,
    isTopSpender: boolean,
    costCapUsd: number | undefined,
    isTopTokenSpender: boolean,
    costCapTokens: number | undefined
  ): { tripping: boolean; reason: string } {
    // (b) repeated identical tool calls
    if (s.repeatCount >= cfg.repeatedToolLimit) {
      return { tripping: true, reason: `looping: ${s.repeatCount}× identical tool call (${s.repeatKey?.split(':')[0] ?? '?'})` };
    }
    // (b) api_error storm
    if (s.errorCount >= cfg.errorStormLimit) {
      return { tripping: true, reason: `error storm: ${s.errorCount} consecutive api errors/retries` };
    }
    // (a) per-agent token limit — this agent's own total over its configured cap
    const perAgentCap = cfg.agentTokenCaps?.[input.agentId];
    if (typeof perAgentCap === 'number' && perAgentCap > 0 && tokensOf(input.sample) > perAgentCap) {
      return { tripping: true, reason: `token limit: ${tokensOf(input.sample).toLocaleString()} over the agent cap of ${perAgentCap.toLocaleString()}` };
    }
    // (a) cost cap — floor total over cap, this agent is the biggest spender
    if (isTopSpender && typeof costCapUsd === 'number') {
      return { tripping: true, reason: `cost cap: floor total over $${costCapUsd} (top spender $${(input.sample?.usd ?? 0).toFixed(2)})` };
    }
    // (a) token cap — floor total tokens over cap, this agent is the biggest spender
    if (isTopTokenSpender && typeof costCapTokens === 'number') {
      return { tripping: true, reason: `token cap: floor total over ${costCapTokens.toLocaleString()} tokens (top spender ${tokensOf(input.sample).toLocaleString()})` };
    }
    // (a) token-velocity spike — diff cumulative output across consecutive beats.
    // Skipped entirely while a compaction is in flight (+ trailing grace): a
    // /compact burns output tokens with no coordination writes, which is the
    // false-positive shape of issue #109 — the auto-compact mission tripping
    // the breaker on idle agents.
    if (input.sample && s.lastSample && nowMs >= s.compactingUntil) {
      const dOut = input.sample.output - s.lastSample.output;
      const dMin = (input.sample.ts - s.lastSample.ts) / 60_000;
      if (dOut > 0 && dMin > 0) {
        const velocity = dOut / dMin;
        if (velocity > cfg.tokenVelocityPerMin) {
          return { tripping: true, reason: `token velocity ${Math.round(velocity)}/min > ${cfg.tokenVelocityPerMin}/min` };
        }
        // (c) no-progress: burning output tokens while not coordinating. A recent
        // DISTINCT tool call counts as progress too — background workflows and
        // interactive sessions do real work that never touches the hive files
        // (a single-call loop never refreshes that clock, and the loop/velocity
        // arms above still backstop). Debounced: fires only after
        // NO_PROGRESS_BEATS consecutive beats, so a one-beat blip never steers.
        const toolActive = nowMs - s.lastDistinctToolAt < PROGRESS_TOOL_WINDOW_MS;
        if (!input.progressing && !toolActive) {
          s.noProgressBeats += 1;
          if (s.noProgressBeats >= NO_PROGRESS_BEATS) {
            return { tripping: true, reason: 'no-progress: generating tokens without coordinating (stale log/files)' };
          }
        } else {
          s.noProgressBeats = 0;
        }
      }
    }
    return { tripping: false, reason: '' };
  }
}
