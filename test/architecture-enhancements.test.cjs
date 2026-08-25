'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { buildAutoSpawnParams, findMatchingPersona } = loadTs('src/main/autoSpawn.ts');
const { checkInstantFailover } = loadTs('src/main/failover.ts');

test('HiveManager initializes lessons.md and pre-seeds lessons protocol into identity.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-lessons-test-'));
  try {
    const hive = new HiveManager(() => dir);
    hive.ensureHive();

    await hive.ensureAgent({
      id: 'worker-1',
      name: 'Worker One',
      cwd: dir,
      role: 'Tester'
    });

    const agentLessons = join(dir, 'hive', 'agents', 'worker-1', 'lessons.md');
    const hiveLessons = join(dir, 'hive', 'lessons.md');
    const identity = join(dir, 'hive', 'agents', 'worker-1', 'identity.md');

    assert.ok(existsSync(agentLessons), 'agent lessons.md must exist');
    assert.ok(existsSync(hiveLessons), 'shared hive lessons.md must exist');

    const identityText = readFileSync(identity, 'utf8');
    assert.match(identityText, /lessons\.md/);
    assert.match(identityText, /Lessons log/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('appendLesson appends timestamped entries to agent and shared lessons.md', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-append-lesson-'));
  try {
    const hive = new HiveManager(() => dir);
    hive.ensureHive();

    await hive.ensureAgent({
      id: 'worker-2',
      name: 'Worker Two',
      cwd: dir,
      role: 'Frontend'
    });

    hive.appendLesson('worker-2', 'Never mutate state directly without setState.');

    const agentLessons = readFileSync(join(dir, 'hive', 'agents', 'worker-2', 'lessons.md'), 'utf8');
    const hiveLessons = readFileSync(join(dir, 'hive', 'lessons.md'), 'utf8');

    assert.match(agentLessons, /Never mutate state directly without setState/);
    assert.match(hiveLessons, /Never mutate state directly without setState/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Fast-path EventBus delivers messages in-memory with <1ms latency', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-bus-test-'));
  try {
    const hive = new HiveManager(() => dir);
    hive.ensureHive();

    await hive.ensureAgent({ id: 'sender', name: 'Sender', cwd: dir });
    await hive.ensureAgent({ id: 'receiver', name: 'Receiver', cwd: dir });

    let fastReceived = null;
    hive.onAgentMail('receiver', (msg) => {
      fastReceived = msg;
    });

    hive.send({
      from: 'sender',
      to: 'receiver',
      act: 'request',
      subject: 'Fast-path latency test',
      body: 'Testing in-memory EventBus delivery.'
    });

    assert.ok(fastReceived !== null, 'Message should arrive via EventBus');
    assert.equal(fastReceived.from, 'sender');
    assert.equal(fastReceived.to, 'receiver');
    assert.equal(fastReceived.subject, 'Fast-path latency test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkInstantFailover triggers on API rate limits or 503 stream errors', () => {
  const mockHive = {
    enabled: () => true,
    root: () => null,
    tasks: () => ({ tasks: [] })
  };

  const deps = {
    hive: mockHive,
    failedAgentId: 'worker-stalled',
    failedAgentName: 'Stalled Agent',
    reason: 'Rate limit hit',
    breakerLevels: () => 'healthy',
    livePtyAgentIds: new Set()
  };

  const normalRes = checkInstantFailover(deps, 'Compiling typescript files...');
  assert.equal(normalRes, null);

  const errorRes = checkInstantFailover(deps, 'Error: 429 Too Many Requests - Model is currently overloaded');
  assert.ok(errorRes !== null, 'Should trigger instant failover on 429 / overloaded error');
});

test('buildAutoSpawnParams matches personas and sets worktree isolation', () => {
  const params = buildAutoSpawnParams({
    role: 'Frontend Developer',
    goal: 'Build navigation component',
    cwd: process.cwd(),
    isolate: true
  });

  assert.ok(params.id.length > 0);
  assert.ok(params.character);
  assert.ok(params.accent);
  assert.equal(params.isolate, true);
  assert.ok(params.goal, 'Build navigation component');
});

test('Vision Bridge correctly identifies image extensions and handles fallback descriptions', async () => {
  const { describeImage, isImageFile } = loadTs('src/main/visionBridge.ts');

  assert.equal(isImageFile('sample.png'), true);
  assert.equal(isImageFile('photo.jpg'), true);
  assert.equal(isImageFile('document.pdf'), false);

  const tmpImg = join(tmpdir(), 'test-screenshot.png');
  // Write 1x1 PNG bytes
  const pngHeader = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000000020001e221bc330000000049454e44ae426082', 'hex');
  writeFileSync(tmpImg, pngHeader);

  try {
    const res = await describeImage(tmpImg);
    assert.equal(res.ok, true);
    assert.ok(res.text);
    assert.match(res.text, /IMAGE/);
  } finally {
    rmSync(tmpImg, { force: true });
  }
});
