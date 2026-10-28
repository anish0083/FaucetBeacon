import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Events, type Client, type DefaultRestOptions } from 'discord.js';
import { attachDiscordStartupDiagnostics, discordGatewayRequest, discordLoginError } from '../src/discord/connection.js';
import type { StartupStage } from '../src/runtime-health.js';

type DiscordResponse = Awaited<ReturnType<typeof DefaultRestOptions.makeRequest>>;

test('Discord login errors retain actionable categories without exposing provider messages', () => {
  const secret = 'credential-from-provider';
  for (const [error, code] of [
    [{ status:401, message:secret }, 'DISCORD_TOKEN'],
    [{ code:'TokenInvalid', message:secret }, 'DISCORD_TOKEN'],
    [{ status:403, message:secret }, 'DISCORD_FORBIDDEN'],
    [{ status:429, message:secret }, 'DISCORD_RATE_LIMIT'],
    [{ status:503, message:secret }, 'DISCORD_UNAVAILABLE'],
    [{ cause:{code:'UND_ERR_CONNECT_TIMEOUT'}, message:secret }, 'DISCORD_NETWORK'],
    [{ message:'Used disallowed intents' }, 'DISCORD_INTENTS'],
    [{ message:'Not enough sessions remaining to spawn 1 shards; private details' }, 'DISCORD_SESSION_LIMIT'],
    [{ code:secret, message:secret }, 'DISCORD_LOGIN'],
    [null, 'DISCORD_LOGIN'],
  ] as const) {
    const failure = discordLoginError(error);
    assert.equal(failure.code, code);
    assert.doesNotMatch(failure.message, /credential-from-provider|private details/);
  }
});

test('gateway request diagnostics reveal rate-limit waits and preserve the transport response', async () => {
  const logs: string[] = [];
  const response = new Response('private-response', { status:429, headers:{'retry-after':'3600'} });
  let calls = 0;
  const transport: typeof DefaultRestOptions.makeRequest = async (_url, options) => {
    calls++;
    assert.deepEqual(options.headers, { Authorization:'Bot private-token' });
    // Node's global Response works here; DOM typings omit stream async iteration.
    return response as unknown as DiscordResponse;
  };
  const request = discordGatewayRequest(message => logs.push(message), transport);
  assert.equal(await request('https://discord.com/api/v10/gateway/bot', {headers:{Authorization:'Bot private-token'}}), response);
  assert.equal(calls, 1);
  assert.equal(response.bodyUsed, false);
  assert.match(logs.join('\n'), /HTTP 429.*3600 seconds/);
  assert.doesNotMatch(logs.join('\n'), /private-response|private-token/);
  await response.body?.cancel();
});

test('gateway diagnostics sanitize malformed headers and network errors without changing retry behavior', async () => {
  const logs: string[] = [];
  const response = new Response('{}', {headers:{'retry-after':'private-header'}});
  const request = discordGatewayRequest(message => logs.push(message), async () => response as unknown as DiscordResponse);
  await request('https://discord.com/api/v10/gateway/bot', {});
  const failure = Object.assign(new Error('private-message'), {cause:{code:'ECONNRESET'}});
  const failing = discordGatewayRequest(message => logs.push(message), async () => {throw failure;});
  await assert.rejects(failing('https://discord.com/api/v10/gateway/bot', {}), error => error === failure);
  assert.match(logs.join('\n'), /DISCORD_NETWORK.*ECONNRESET/);
  assert.doesNotMatch(logs.join('\n'), /private-header|private-message/);
  await response.body?.cancel();
});

test('startup debug logs emit fixed progress labels and detach before reconnection', () => {
  const client = new EventEmitter() as unknown as Client;
  const stages: StartupStage[] = [];
  const logs: string[] = [];
  const stop = attachDiscordStartupDiagnostics(client, stage => stages.push(stage), message => logs.push(message));
  client.emit(Events.Debug, 'Provided token: private-token');
  client.emit(Events.Debug, '[WS => Shard 0] Resuming session\n\tprivate-session');
  assert.equal(logs.length, 0);
  client.emit(Events.Debug, '[WS => Manager] Fetched Gateway Information\n\tURL: private-url');
  client.emit(Events.Debug, '[WS => Shard 0] Connecting to private-url');
  client.emit(Events.Debug, '[WS => Shard 0] Waiting for event hello for 60000ms');
  client.emit(Events.Debug, '[WS => Shard 0] Identifying\n\tprivate-token');
  assert.deepEqual(stages, ['discord_gateway', 'discord_ready']);
  assert.equal(logs.length, 4);
  assert.doesNotMatch(logs.join('\n'), /private-/);
  stop();stop();
  client.emit(Events.Debug, '[WS => Manager] Fetched Gateway Information');
  assert.equal(logs.length, 4);
  assert.equal(client.listenerCount(Events.Debug), 0);
});
