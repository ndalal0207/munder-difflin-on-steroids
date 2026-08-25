/**
 * Automatic Agent Failover & Context Preservation Engine.
 *
 * When a worker agent (e.g. running `opencode --auto` via OmniRoute, or any
 * provider) stalls, hits an API timeout, loops, or is halted by the circuit
 * breaker, this module:
 *   1. Captures the failing agent's working memory (`memory.md`), git workspace
 *      state, and diagnostic reason so no context is lost.
 *   2. Selects the next-best-available healthy agent based on capability matching,
 *      health status, and active workload.
 *   3. Non-destructively reassigns the stalled task in `hive/tasks.json`.
 *   4. Injects a comprehensive `[TASK FAILOVER HANDOFF]` brief into the successor's
 *      inbox and alerts the orchestrator (`god`).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import type { HiveManager, HiveTask, Registry, RegistryAgent } from './hive';
import type { BreakerLevel } from './breaker';
import { patchTaskInLedger } from '../shared/taskLedger';

export interface AgentHandoffContext {
  memorySummary: string | null;
  lessonsSummary: string | null;
  gitSummary: string | null;
}

export interface NextAgentCandidatesInput {
  registry: Registry;
  failedAgentId: string;
  breakerLevels: (id: string) => BreakerLevel;
  livePtyAgentIds: Set<string>;
  activeTaskCountByAgent?: Map<string, number>;
  requiredCapabilities?: string[];
}

export interface FailoverDeps {
  hive: HiveManager;
  failedAgentId: string;
  failedAgentName: string;
  reason: string;
  breakerLevels: (id: string) => BreakerLevel;
  livePtyAgentIds: Set<string>;
  worktreePaths?: Map<string, string>;
  notifyToast?: (title: string, body: string) => void;
}

export interface FailoverResult {
  remappedTasks: Array<{ taskId: string; from: string; to: string; title: string }>;
  unassignedTasks: Array<{ taskId: string; title: string }>;
}

/**
 * Extract rich context from an agent's workspace before tearing down or failing over.
 * Extracts:
 * - Durable memory facts from `<hive>/agents/<agentId>/memory.md`.
 * - Git status & recent commits in the working tree (if applicable).
 */
export function extractHandoffContext(
  hiveRoot: string | null,
  agentId: string,
  worktreeCwd?: string
): AgentHandoffContext {
  let memorySummary: string | null = null;
  let lessonsSummary: string | null = null;
  let gitSummary: string | null = null;

  if (hiveRoot) {
    const memPath = join(hiveRoot, 'agents', agentId, 'memory.md');
    try {
      if (existsSync(memPath)) {
        const raw = readFileSync(memPath, 'utf8').trim();
        if (raw) {
          memorySummary = raw.length > 2000 ? `... (truncated)\n${raw.slice(-2000)}` : raw;
        }
      }
    } catch {
      /* non-fatal */
    }

    const lessonsPath = join(hiveRoot, 'agents', agentId, 'lessons.md');
    try {
      if (existsSync(lessonsPath)) {
        const raw = readFileSync(lessonsPath, 'utf8').trim();
        if (raw) {
          lessonsSummary = raw.length > 1500 ? `... (truncated)\n${raw.slice(-1500)}` : raw;
        }
      }
    } catch {
      /* non-fatal */
    }
  }

  if (worktreeCwd && existsSync(worktreeCwd)) {
    try {
      const status = execSync('git status --short', { cwd: worktreeCwd, encoding: 'utf8', timeout: 3000 }).trim();
      const lastCommit = execSync('git log -n 1 --oneline', { cwd: worktreeCwd, encoding: 'utf8', timeout: 3000 }).trim();
      const parts: string[] = [];
      if (lastCommit) parts.push(`Latest commit: ${lastCommit}`);
      if (status) parts.push(`Uncommitted changes:\n${status}`);
      if (parts.length > 0) gitSummary = parts.join('\n\n');
    } catch {
      /* non-fatal */
    }
  }

  return { memorySummary, lessonsSummary, gitSummary };
}

/**
 * Find the next best healthy candidate on the floor to take over work.
 * Criteria:
 * - Active, not archived, not on hold, not assistant
 * - Not the failed agent, and not the God orchestrator
 * - Breaker level is 'healthy'
 * - Owns a live running PTY
 * - Scored by capability overlap and lowest active workload
 */
export function findNextBestAgent(input: NextAgentCandidatesInput): RegistryAgent | null {
  const {
    registry,
    failedAgentId,
    breakerLevels,
    livePtyAgentIds,
    activeTaskCountByAgent = new Map(),
    requiredCapabilities = []
  } = input;

  const candidates: Array<{ agent: RegistryAgent; score: number }> = [];

  for (const [id, a] of Object.entries(registry.agents) as [string, RegistryAgent][]) {
    if (a.archived || a.onHold || a.isAssistant) continue;
    if (id === failedAgentId || id === registry.godId) continue;
    if (!livePtyAgentIds.has(id)) continue;
    if (breakerLevels(id) !== 'healthy') continue;

    let score = 100; // Base score for healthy live worker

    // Capability match bonus
    if (requiredCapabilities.length > 0 && Array.isArray(a.capabilities)) {
      for (const cap of requiredCapabilities) {
        if (a.capabilities.includes(cap)) score += 25;
      }
    }

    // Workload penalty (fewer active tasks = better candidate)
    const activeTasks = activeTaskCountByAgent.get(id) ?? 0;
    score -= activeTasks * 15;

    candidates.push({ agent: a, score });
  }

  if (candidates.length === 0) return null;

  candidates.sort((x, y) => y.score - x.score);
  return candidates[0].agent;
}

/**
 * Reassign any in-flight or stalled tasks owned by a failing agent to the next best agent,
 * passing full context, updating `tasks.json`, and alerting the hive.
 */
export function failoverStalledTasks(deps: FailoverDeps): FailoverResult {
  const {
    hive,
    failedAgentId,
    failedAgentName,
    reason,
    breakerLevels,
    livePtyAgentIds,
    worktreePaths,
    notifyToast
  } = deps;

  const result: FailoverResult = { remappedTasks: [], unassignedTasks: [] };
  if (!hive.enabled()) return result;

  const hiveRoot = hive.root();
  const rawLedger = hive.tasks() as { tasks?: unknown[] };
  const allTasks = Array.isArray(rawLedger?.tasks) ? (rawLedger.tasks as Record<string, unknown>[]) : [];

  // Find active tasks assigned to the failing agent
  const stalledTasks = allTasks.filter(
    (t) => t.assignee === failedAgentId && (t.status === 'doing' || t.status === 'blocked' || t.status === 'todo')
  );

  if (stalledTasks.length === 0) return result;

  const registry = hive.registry();
  const activeTaskCountByAgent = new Map<string, number>();
  for (const t of allTasks) {
    if (typeof t.assignee === 'string' && t.status === 'doing') {
      activeTaskCountByAgent.set(t.assignee, (activeTaskCountByAgent.get(t.assignee) ?? 0) + 1);
    }
  }

  const worktreeCwd = worktreePaths?.get(failedAgentId);
  const handoffContext = extractHandoffContext(hiveRoot, failedAgentId, worktreeCwd);

  let updatedTasks = [...allTasks];

  for (const task of stalledTasks) {
    const taskId = String(task.id ?? '');
    const taskTitle = String(task.title ?? taskId);
    const requiredCaps = Array.isArray(task.capabilities) ? (task.capabilities as string[]) : [];

    const nextAgent = findNextBestAgent({
      registry,
      failedAgentId,
      breakerLevels,
      livePtyAgentIds,
      activeTaskCountByAgent,
      requiredCapabilities: requiredCaps
    });

    const nowIso = new Date().toISOString();

    if (nextAgent) {
      // Reassign task in tasks.json
      updatedTasks = patchTaskInLedger(updatedTasks, taskId, {
        assignee: nextAgent.id,
        status: 'doing',
        failover: {
          from: failedAgentId,
          fromName: failedAgentName,
          reason,
          at: nowIso
        }
      }) as Record<string, unknown>[];

      // Build rich handoff prompt body
      const handoffBody = [
        `[TASK FAILOVER HANDOFF — RESUME IN-FLIGHT WORK]`,
        `You have been assigned task "${taskTitle}" (ID: ${taskId}) as an automatic failover from ${failedAgentName} (ID: ${failedAgentId}).`,
        ``,
        `## Failover Trigger`,
        `${reason}`,
        ``,
        `## Primary Objective`,
        `${task.description || taskTitle}`,
        ``,
        handoffContext.memorySummary ? `## Previous Agent's Working Memory\n${handoffContext.memorySummary}\n` : '',
        handoffContext.gitSummary ? `## Workspace & Git Status\n${handoffContext.gitSummary}\n` : '',
        `## Instructions`,
        `1. Inspect the workspace at your cwd (${nextAgent.cwd}) for any partial diffs or files already created.`,
        `2. Resume the objective directly without starting over from scratch.`,
        `3. Keep tasks.json updated with your progress and report completion to Michael (god).`
      ].filter(Boolean).join('\n');

      // Send to successor agent's inbox
      hive.send(
        {
          to: nextAgent.id,
          act: 'request',
          subject: `Task handoff: ${taskTitle}`,
          body: handoffBody
        },
        'failover'
      );

      // Notify orchestrator (god)
      hive.send(
        {
          to: 'god',
          act: 'inform',
          subject: `Task failover: ${taskTitle} -> ${nextAgent.name}`,
          body: `Automatic failover: Task "${taskTitle}" (ID: ${taskId}) was transferred from ${failedAgentName} to ${nextAgent.name} (reason: ${reason}).`
        },
        'failover'
      );

      hive.appendLog({
        kind: 'failover',
        from: failedAgentId,
        to: nextAgent.id,
        taskId,
        reason
      });

      result.remappedTasks.push({
        taskId,
        from: failedAgentId,
        to: nextAgent.id,
        title: taskTitle
      });

      if (notifyToast) {
        notifyToast(`Task failed over to ${nextAgent.name}`, `Re-assigned "${taskTitle}" from ${failedAgentName}`);
      }

      // Update local count for subsequent loop iterations
      activeTaskCountByAgent.set(nextAgent.id, (activeTaskCountByAgent.get(nextAgent.id) ?? 0) + 1);
    } else {
      // No live candidate found on the floor — park card and alert god
      updatedTasks = patchTaskInLedger(updatedTasks, taskId, {
        status: 'blocked',
        failover: {
          from: failedAgentId,
          fromName: failedAgentName,
          unassigned: true,
          reason,
          at: nowIso
        }
      }) as Record<string, unknown>[];

      hive.send(
        {
          to: 'god',
          act: 'inform',
          subject: `Task stranded: ${taskTitle} (no available worker)`,
          body: `Task "${taskTitle}" (ID: ${taskId}) stalled under ${failedAgentName} (${reason}), but no healthy worker was available to take it. Please spawn a worker or take over.`
        },
        'failover'
      );

      result.unassignedTasks.push({ taskId, title: taskTitle });
    }
  }

  // Persist updated task ledger
  hive.writeTasks(updatedTasks as unknown as HiveTask[]);
  return result;
}

const API_ERROR_RE = /(?:429|503\s+Service\s+Unavailable|rate\s*limit|quota\s*exceeded|overloaded|model\s+is\s+currently\s+overloaded|Unable\s+to\s+determine\s+provider)/i;

/** Check PTY stream output for immediate API errors or rate-limit messages to trigger zero-latency (<500ms) failover. */
export function checkInstantFailover(deps: FailoverDeps, ptyChunk: string): FailoverResult | null {
  if (API_ERROR_RE.test(ptyChunk)) {
    return failoverStalledTasks({
      ...deps,
      reason: `[Instant Failover] API Rate Limit / Model Overload detected in stream output: ${deps.reason}`
    });
  }
  return null;
}
