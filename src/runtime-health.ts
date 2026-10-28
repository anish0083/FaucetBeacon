import { FaucetError } from './domain.js';

export type StartupStage = 'database' | 'discord_login' | 'commands' | 'chain' | 'settings' | 'running' | 'shutdown';
export type RuntimeStatus = { status: 'starting' | 'ready' | 'reconnecting' | 'stopping'; stage: StartupStage };

/** Bound startup and lost Discord sessions, including promises that never settle. */
export class RuntimeHealth {
  private stage: StartupStage = 'database';
  private readonly startedAt: number;
  private disconnectedAt: number | null = null;

  constructor(private readonly now: () => number = () => performance.now(),
    private readonly startupTimeoutMs = 5 * 60_000, private readonly reconnectTimeoutMs = 2 * 60_000) {
    this.startedAt = now();
  }

  setStage(stage: StartupStage): void { this.stage = stage; }

  status(ready: boolean): RuntimeStatus {
    if (this.stage === 'shutdown') return { status: 'stopping', stage: this.stage };
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
    if (status.status === 'starting' && this.now() - this.startedAt >= this.startupTimeoutMs) {
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
