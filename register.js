import { REST, Routes, SlashCommandBuilder } from 'discord.js';

const commands = [
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Verify your DL Clan membership')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Refreshing slash commands...');
        await rest.put(
            Routes.applicationCommands('1543209702530220082'),
            { body: commands },
        );
        console.log('Successfully registered /verify command!');
    } catch (error) {
        console.error(error);
    }
})();
