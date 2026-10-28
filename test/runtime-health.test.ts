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

test('the 41450-second Discord cooldown suspends startup timeout and leaves a bounded recovery window', () => {
  let now=0;
  const health=new RuntimeHealth(()=>now,100,50);
  health.setStage('discord_login');
  health.deferDiscordRetry(41_450_000);
  assert.deepEqual(health.check(false),{status:'rate_limited',stage:'discord_login',retryAfterSeconds:41451});
  now=5*60_000;
  assert.equal(health.check(false).status,'rate_limited');
  now=41_451_000;
  assert.deepEqual(health.check(false),{status:'starting',stage:'discord_login'});
  now+=99;health.check(false);
  now+=1;assert.throws(()=>health.check(false),errorCode('STARTUP_TIMEOUT'));
});

test('Discord cooldown also pauses reconnect timeout and a healthy connection clears it', () => {
  let now=0;
  const health=new RuntimeHealth(()=>now,100,50);
  health.setStage('running');health.check(false);
  health.deferDiscordRetry(1000);
  now=100;assert.equal(health.check(false).status,'rate_limited');
  now=2000;assert.equal(health.check(false).status,'reconnecting');
  now=2049;health.check(false);
  now=2050;assert.throws(()=>health.check(false),errorCode('DISCORD_RECONNECT_TIMEOUT'));
  health.deferDiscordRetry(1000);
  assert.equal(health.check(true).status,'ready');
  assert.equal(health.check(false).status,'reconnecting');
});

test('invalid retry delays cannot disable the watchdog and cooldown cannot undo shutdown', () => {
  let now=0;
  const health=new RuntimeHealth(()=>now,100,50);
  for(const delay of [NaN,Infinity,-1,0,1.5]) health.deferDiscordRetry(delay);
  now=100;assert.throws(()=>health.check(false),errorCode('STARTUP_TIMEOUT'));
  health.setStage('shutdown');health.deferDiscordRetry(41_450_000);
  assert.equal(health.check(false).status,'stopping');
});
