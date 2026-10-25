import { REST } from 'discord.js';
import { discordConfig } from './config.js';
import { registerGuildCommands } from './discord/register.js';
import { safeError } from './domain.js';

try {
  const config=discordConfig();
  const rest=new REST({version:'10'}).setToken(config.token);
  for (const guildId of config.guildIds) {
    await registerGuildCommands(rest,config.clientId,guildId);
    console.log(`Registered /faucet, /faucet-admin and /faucet-mod in server ${guildId}.`);
  }
} catch (error) {console.error(safeError(error));process.exitCode=1;}
