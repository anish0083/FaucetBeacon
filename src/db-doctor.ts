import { discordGuildIds, supabaseConfig } from './config.js';
import { SupabaseStore } from './supabase-store.js';
import { FaucetError, safeError } from './domain.js';

try {
  const store = new SupabaseStore(supabaseConfig());
  const health = await store.health();
  if (health.schemaVersion !== 3) throw new FaucetError('DATABASE_SCHEMA', 'Supabase is connected. Apply the current supabase/schema.sql (version 3, multiple servers) before starting the bot.');
  console.log('FaucetBot Supabase connection and schema version 3 verified.');
  console.log(health.initialized ? 'The database is initialized.' : 'The database is ready. Bot startup will bind the server and funding wallet.');
  if (process.env.DISCORD_GUILD_IDS || process.env.DISCORD_GUILD_ID) {
    for (const guildId of discordGuildIds()) {
      const scoped = store.forGuild(guildId);
      if (!(await scoped.health()).initialized) { console.log(`Server ${guildId}: ready for first startup.`); continue; }
      const [settings, channels, pending] = await Promise.all([scoped.settings(), scoped.channels(), scoped.countPending()]);
      console.log(`Server ${guildId}: ${settings.enabled ? 'running' : 'paused'}; ${channels.length} approved channel(s); ${pending} pending payout(s).`);
    }
  }
  console.log('Read-only check complete. No records changed and no transfers sent.');
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
