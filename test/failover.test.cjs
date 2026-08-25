'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { findNextBestAgent, extractHandoffContext, failoverStalledTasks } = loadTs('src/main/failover.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

function makeTmpHive() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-failover-test-'));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  return { home, hive };
}

test('findNextBestAgent chooses the healthiest and most relevant agent', () => {
  const registry = {
    version: 1,
    godId: 'michael',
    agents: {
      michael: { id: 'michael', name: 'Michael', isGod: true, cwd: '/tmp', status: 'idle', lastSeen: Date.now() },
      jim: { id: 'jim', name: 'Jim', role: 'Sales & Reviewer', capabilities: ['pr-review', 'typescript'], cwd: '/tmp/jim', status: 'working', lastSeen: Date.now() },
      dwight: { id: 'dwight', name: 'Dwight', role: 'QA Enforcer', capabilities: ['testing', 'qa'], cwd: '/tmp/dwight', status: 'idle', lastSeen: Date.now() },
      creed: { id: 'creed', name: 'Creed', role: 'Security', capabilities: ['security'], cwd: '/tmp/creed', status: 'idle', lastSeen: Date.now(), archived: true },
      kevin: { id: 'kevin', name: 'Kevin', role: 'Accounting', capabilities: ['math'], cwd: '/tmp/kevin', status: 'idle', lastSeen: Date.now() }
    }
  };

  const livePtyAgentIds = new Set(['michael', 'jim', 'dwight', 'kevin']);
  const breakerLevels = (id) => (id === 'kevin' ? 'constrained' : 'healthy');

  // Failed agent is Jim. Jim was handling QA/testing task.
  const candidate = findNextBestAgent({
    registry,
    failedAgentId: 'jim',
    breakerLevels,
    livePtyAgentIds,
    requiredCapabilities: ['qa']
  });

  assert.ok(candidate, 'A candidate should be found');
  assert.equal(candidate.id, 'dwight', 'Dwight matches capabilities and is healthy');
});

test('findNextBestAgent returns null if no healthy live workers exist', () => {
  const registry = {
    version: 1,
    godId: 'michael',
    agents: {
      michael: { id: 'michael', name: 'Michael', isGod: true, cwd: '/tmp', status: 'idle', lastSeen: Date.now() },
      jim: { id: 'jim', name: 'Jim', cwd: '/tmp/jim', status: 'working', lastSeen: Date.now() }
    }
  };

  const candidate = findNextBestAgent({
    registry,
    failedAgentId: 'jim',
    breakerLevels: () => 'healthy',
    livePtyAgentIds: new Set(['jim'])
  });

  assert.equal(candidate, null, 'No candidate when only god and the failed agent exist');
});

test('extractHandoffContext reads memory.md correctly', () => {
  const { home, hive } = makeTmpHive();
  const hiveRoot = hive.root();
  const agentDir = path.join(hiveRoot, 'agents', 'dwight');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'memory.md'), 'Key facts: Schrute farms beet inventory is up to date.\nTask partial progress: inspected src/auth.ts.', 'utf8');

  const ctx = extractHandoffContext(hiveRoot, 'dwight');
  assert.ok(ctx.memorySummary);
  assert.match(ctx.memorySummary, /Schrute farms beet inventory/);
  assert.match(ctx.memorySummary, /src\/auth\.ts/);
});

test('failoverStalledTasks re-assigns tasks and delivers context to successor agent', (t) => {
  const { home, hive } = makeTmpHive();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  // Register god and worker agents in hive
  hive.ensureAgent({ id: 'michael', name: 'Michael', role: 'orchestrator', cwd: home, isGod: true });
  hive.ensureAgent({ id: 'opencode-worker', name: 'OpenCode Agent', role: 'Builder', cwd: path.join(home, 'w1'), capabilities: ['build'] });
  hive.ensureAgent({ id: 'claude-worker', name: 'Claude Agent', role: 'Senior Builder', cwd: path.join(home, 'w2'), capabilities: ['build'] });

  // Write a task assigned to opencode-worker
  hive.writeTasks([
    {
      id: 'task-build-pipeline',
      title: 'Fix the flaking build pipeline',
      description: 'Investigate CI test runner flakiness on node 22',
      assignee: 'opencode-worker',
      status: 'doing',
      priority: 1,
      dependsOn: [],
      createdAt: '2026-08-24T12:00:00.000Z',
      repo: 'munder-difflin-core',
      slack: { channel: 'C123', thread_ts: '123.456' }
    }
  ]);

  // Write memory for failing agent
  const memDir = path.join(hive.root(), 'agents', 'opencode-worker');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, 'memory.md'), 'Tried restarting worker with --auto flag; timed out on OmniRoute free endpoint.', 'utf8');

  const livePty = new Set(['michael', 'opencode-worker', 'claude-worker']);
  let toastFired = false;

  const result = failoverStalledTasks({
    hive,
    failedAgentId: 'opencode-worker',
    failedAgentName: 'OpenCode Agent',
    reason: 'OmniRoute endpoint timeout & repeated stall',
    breakerLevels: (id) => (id === 'opencode-worker' ? 'stopped' : 'healthy'),
    livePtyAgentIds: livePty,
    notifyToast: () => { toastFired = true; }
  });

  assert.equal(result.remappedTasks.length, 1);
  assert.equal(result.remappedTasks[0].to, 'claude-worker');
  assert.equal(toastFired, true);

  // Verify task was re-assigned in tasks.json while preserving slack metadata
  const tasks = hive.tasks().tasks;
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].assignee, 'claude-worker');
  assert.equal(tasks[0].status, 'doing');
  assert.deepEqual(tasks[0].slack, { channel: 'C123', thread_ts: '123.456' });
  assert.ok(tasks[0].failover, 'Failover audit metadata should be attached');
  assert.equal(tasks[0].failover.from, 'opencode-worker');

  // Verify successor received handoff brief in inbox
  const successorInbox = hive.inbox('claude-worker');
  assert.equal(successorInbox.length, 1);
  assert.match(successorInbox[0].subject, /Task handoff: Fix the flaking build pipeline/);
  assert.match(successorInbox[0].body, /TASK FAILOVER HANDOFF/);
  assert.match(successorInbox[0].body, /OmniRoute endpoint timeout/);
  assert.match(successorInbox[0].body, /Tried restarting worker with --auto flag/);

  // Verify orchestrator (god) was notified
  const godInbox = hive.inbox('michael');
  assert.equal(godInbox.length, 1);
  assert.match(godInbox[0].subject, /Task failover/);
});

test('failoverStalledTasks parks task and alerts god when no worker candidate is available', (t) => {
  const { home, hive } = makeTmpHive();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));

  hive.ensureAgent({ id: 'michael', name: 'Michael', role: 'orchestrator', cwd: home, isGod: true });
  hive.ensureAgent({ id: 'alone-worker', name: 'Alone Worker', cwd: path.join(home, 'w1') });

  hive.writeTasks([
    {
      id: 'task-lone',
      title: 'Solo task',
      assignee: 'alone-worker',
      status: 'doing',
      priority: 1,
      dependsOn: [],
      createdAt: '2026-08-24T12:00:00.000Z'
    }
  ]);

  const result = failoverStalledTasks({
    hive,
    failedAgentId: 'alone-worker',
    failedAgentName: 'Alone Worker',
    reason: 'Rate limit exhaustion',
    breakerLevels: () => 'stopped',
    livePtyAgentIds: new Set(['michael', 'alone-worker'])
  });

  assert.equal(result.remappedTasks.length, 0);
  assert.equal(result.unassignedTasks.length, 1);

  const tasks = hive.tasks().tasks;
  assert.equal(tasks[0].status, 'blocked');
  assert.equal(tasks[0].failover.unassigned, true);

  const godInbox = hive.inbox('michael');
  assert.equal(godInbox.length, 1);
  assert.match(godInbox[0].subject, /Task stranded: Solo task/);
});
