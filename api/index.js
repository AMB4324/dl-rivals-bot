const { Client, GatewayIntentBits, SlashCommandBuilder, REST, Routes } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const creds = require('./credentials.json'); 

const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet('YOUR_SHEET_ID_HERE', serviceAccountAuth);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Register Slash Command
const commands = [
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Fetch device info for a user from Google Sheets')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('The name to search in the sheet')
                .setRequired(true))
].map(command => command.toJSON());

client.once('ready', async () => {
    console.log(`Bot logged in as ${client.user.tag}`);

    // Register slash commands globally (or per guild)
    const rest = new REST({ version: '10' }).setToken('YOUR_DISCORD_BOT_TOKEN');
    try {
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: commands }
        );
        console.log('Slash commands registered successfully!');
    } catch (error) {
        console.error('Error registering slash commands:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    // Only process slash commands
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'verify') {
        const targetName = interaction.options.getString('name');

        // 1. DEFER IMMEDIATELY to prevent the 3-second timeout!
        await interaction.deferReply(); 

        try {
            await doc.loadInfo();
            const sheet = doc.sheetsByIndex[0];
            const rows = await sheet.getRows();

            const row = rows.find(r => r.get('Name')?.toLowerCase() === targetName.toLowerCase());

            if (row) {
                const device = row.get('Device') || 'N/A';
                const name = row.get('Name');

                // 2. EDIT DEFERRED REPLY once sheet data is fetched
                await interaction.editReply(`📱 **${name}** plays on: **${device}**`);
            } else {
                await interaction.editReply(`❌ Could not find user **${targetName}** in the sheet.`);
            }
        } catch (error) {
            console.error(error);
            await interaction.editReply('There was an error reading the Google Sheet.');
        }
    }
});

client.login('YOUR_DISCORD_BOT_TOKEN');
