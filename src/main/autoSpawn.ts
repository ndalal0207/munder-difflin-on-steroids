/**
 * Autonomous Agent Auto-Spawner:
 * Automatically provisions and spawns an isolated worker agent in a Git worktree when tasks arrive,
 * matching candidate .md agent definitions from ~/.claude/agents/ or project .claude/agents/
 * so the system can operate without requiring manual UI clicking.
 */

import { scanGlobalClaudeAgents } from './hire';
import type { HireManifest } from '../shared/hire';

export interface AutoSpawnOptions {
  role: string;
  goal: string;
  cwd: string;
  capabilities?: string[];
  isolate?: boolean;
  provider?: 'claude' | 'antigravity' | 'codex' | 'cursor';
  model?: string;
}

const CHARACTERS = ['pam', 'jim', 'dwight', 'michael', 'ryan', 'oscar', 'kevin', 'stanley', 'phyllis', 'angela', 'creed', 'darryl', 'wallace'];
const ACCENTS = ['sky', 'mint', 'lemon', 'coral', 'lavender', 'slate'];

let counter = 0;

/** Match the best .md agent persona for a given role/task description. */
export function findMatchingPersona(role: string, cwd?: string): HireManifest | undefined {
  const scanned = scanGlobalClaudeAgents(cwd);
  if (!scanned.agents || scanned.agents.length === 0) return undefined;

  const needle = role.toLowerCase();
  // Try exact keyword match first
  for (const item of scanned.agents) {
    const nameMatch = item.manifest.name.toLowerCase();
    const descMatch = (item.manifest.description || '').toLowerCase();
    const fileMatch = item.filename.toLowerCase();
    if (needle.includes(nameMatch) || needle.includes(fileMatch.replace(/\.md$/, '')) || descMatch.includes(needle)) {
      return item.manifest;
    }
  }

  // Fall back to fuzzy capability match
  for (const item of scanned.agents) {
    if (item.manifest.capabilities && item.manifest.capabilities.some((c) => needle.includes(c.toLowerCase()))) {
      return item.manifest;
    }
  }

  // Return head if available
  return scanned.agents[0]?.manifest;
}

/** Assembles parameters for auto-spawning an autonomous worker agent. */
export function buildAutoSpawnParams(opts: AutoSpawnOptions): {
  id: string;
  name: string;
  character: string;
  accent: string;
  role: string;
  goal: string;
  persona?: string;
  isolate: boolean;
} {
  const matched = findMatchingPersona(opts.role, opts.cwd);
  counter += 1;
  const stamp = Date.now().toString(36).slice(-4);
  const character = matched?.character ?? CHARACTERS[counter % CHARACTERS.length];
  const accent = matched?.accent ?? ACCENTS[counter % ACCENTS.length];

  const name = matched?.name
    ? `${matched.name}-${stamp}`
    : `${opts.role.replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 16).toLowerCase()}-${stamp}`;

  return {
    id: name.toLowerCase(),
    name,
    character,
    accent,
    role: matched?.description ?? opts.role,
    goal: opts.goal || matched?.goal || '',
    persona: matched?.persona,
    isolate: opts.isolate ?? true
  };
}
