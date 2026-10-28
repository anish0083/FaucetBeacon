import { FaucetError } from './domain.js';

export type StartupStage = 'database' | 'discord_login' | 'discord_gateway' | 'discord_ready' | 'commands' | 'chain' | 'settings' | 'running' | 'shutdown';
export type RuntimeStatus = { status: 'starting' | 'ready' | 'reconnecting' | 'stopping' | 'rate_limited'; stage: StartupStage; retryAfterSeconds?: number };

/** Bound startup and lost Discord sessions, including promises that never settle. */
export class RuntimeHealth {
  private stage: StartupStage = 'database';
  private startupDeadline: number;
  private disconnectedAt: number | null = null;
  private rateLimitedUntil = 0;

  constructor(private readonly now: () => number = () => performance.now(),
    private readonly startupTimeoutMs = 5 * 60_000, private readonly reconnectTimeoutMs = 2 * 60_000) {
    this.startupDeadline = now() + startupTimeoutMs;
  }

  setStage(stage: StartupStage): void { if (this.stage !== 'shutdown') this.stage = stage; }

  deferDiscordRetry(waitMs: number): void {
    if (this.stage === 'shutdown' || !Number.isSafeInteger(waitMs) || waitMs <= 0) return;
    // Discord REST adds a small rate-limit offset. Leave one extra second for it.
    this.rateLimitedUntil = Math.max(this.rateLimitedUntil, this.now() + waitMs + 1000);
    this.startupDeadline = Math.max(this.startupDeadline, this.rateLimitedUntil + this.startupTimeoutMs);
    this.disconnectedAt = null;
  }

  status(ready: boolean): RuntimeStatus {
    if (this.stage === 'shutdown') return { status: 'stopping', stage: this.stage };
    if (this.stage === 'running' && ready) this.rateLimitedUntil = 0;
    if (this.rateLimitedUntil > this.now()) return {
      status: 'rate_limited', stage: this.stage, retryAfterSeconds: Math.ceil((this.rateLimitedUntil - this.now()) / 1000),
    };
    if (this.stage !== 'running') return { status: 'starting', stage: this.stage };
    if (ready) {
      this.disconnectedAt = null;
      return { status: 'ready', stage: this.stage };
    }
    this.disconnectedAt ??= this.now();
    return { status: 'reconnecting', stage: this.stage };
  }

  check(ready: boolean): RuntimeStatus {
    const status = this.status(ready);
    if (status.status === 'starting' && this.now() >= this.startupDeadline) {
      throw new FaucetError('STARTUP_TIMEOUT', `Bot startup stalled at ${this.stage} for ${this.startupTimeoutMs / 1000} seconds. Exiting so the host can restart it.`);
    }
    if (status.status === 'reconnecting' && this.now() - this.disconnectedAt! >= this.reconnectTimeoutMs) {
      throw new FaucetError('DISCORD_RECONNECT_TIMEOUT', `Discord stayed disconnected for ${this.reconnectTimeoutMs / 1000} seconds. Exiting so the host can restart it.`);
    }
    return status;
  }
}

export function startRuntimeWatchdog(health: RuntimeHealth, ready: () => boolean,
  fail: (error: unknown) => void, log: (message: string) => void = console.log, intervalMs = 5000): () => void {
  let lastStatus = '';
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    try {
      const state = health.check(ready());
      const status = `${state.status} (${state.stage})`;
      if (status !== lastStatus) { lastStatus = status; log(`Bot health: ${status}.`); }
    } catch (error) {
      stopped = true;
      clearInterval(timer);
      fail(error);
    }
  }, intervalMs);
  timer.unref();
  return () => { stopped = true; clearInterval(timer); };
}
