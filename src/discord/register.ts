import { REST, Routes } from 'discord.js';
import { commandData } from './commands.js';

export async function registerGuildCommands(rest: REST, clientId: string, guildId: string): Promise<void> {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commandData });
}
