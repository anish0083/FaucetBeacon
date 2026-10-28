import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeHealth, startRuntimeWatchdog } from '../src/runtime-health.js';
import { errorCode } from './helpers.js';

test('startup has one deadline across stages, even if Discord itself is ready', () => {
  let now = 0;
  const health = new RuntimeHealth(() => now, 100, 50);
  assert.deepEqual(health.check(false), { status: 'starting', stage: 'database' });
  now = 70;
  health.setStage('discord_login');
  health.check(false);
  health.setStage('commands');
  now = 100;
  assert.throws(() => health.check(true), errorCode('STARTUP_TIMEOUT'));
});

test('running Discord disconnects report reconnecting and recovery resets the deadline', () => {
  let now = 0;
  const health = new RuntimeHealth(() => now, 100, 50);
  health.setStage('running');
  assert.equal(health.check(true).status, 'ready');
  now = 1000; // A healthy process can outlive the startup deadline.
  assert.equal(health.check(true).status, 'ready');
  assert.deepEqual(health.check(false), { status: 'reconnecting', stage: 'running' });
  now += 49;
  health.check(false);
  health.check(true);
  now += 100;
  health.check(false);
  now += 49;
  health.check(false);
  now += 1;
  assert.throws(() => health.check(false), errorCode('DISCORD_RECONNECT_TIMEOUT'));
});

test('an intentional shutdown does not trigger a connection restart', () => {
  let now = 0;
  const health = new RuntimeHealth(() => now, 100, 50);
  health.setStage('running');
  health.check(false);
  health.setStage('shutdown');
  health.setStage('discord_ready'); // A late startup event cannot undo shutdown.
  now = 1000;
  assert.deepEqual(health.check(false), { status: 'stopping', stage: 'shutdown' });
});

test('the watchdog fires independently of a stalled startup and stops after failure', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let now = 0;
  const health = new RuntimeHealth(() => now, 100, 50);
  const failures: unknown[] = [];
  const logs: string[] = [];
  const stop = startRuntimeWatchdog(health, () => false, error => failures.push(error), message => logs.push(message), 10);
  try {
    t.mock.timers.tick(10);
    t.mock.timers.tick(10);
    assert.deepEqual(logs, ['Bot health: starting (database).']);
    now = 100;
    t.mock.timers.tick(10);
    assert.equal(failures.length, 1);
    assert.ok(errorCode('STARTUP_TIMEOUT')(failures[0]));
    t.mock.timers.tick(100);
    assert.equal(failures.length, 1);
  } finally { stop(); }
});

test('stopping the watchdog cancels pending checks', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const health = new RuntimeHealth(() => 0, 0, 0);
  let failures = 0;
  const stop = startRuntimeWatchdog(health, () => false, () => { failures++; }, () => {}, 10);
  stop();
  t.mock.timers.tick(100);
  assert.equal(failures, 0);
});
