const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Load Google Service Account Credentials
const creds = require('./credentials.json');

// Setup Google Sheets Auth
const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Replace with your Google Sheet ID (from the URL)
const SHEET_ID = 'YOUR_GOOGLE_SHEET_ID_HERE';
const doc = new GoogleSpreadsheet(SHEET_ID, serviceAccountAuth);

// Replace with your Bot Token and Client ID
const BOT_TOKEN = 'YOUR_DISCORD_BOT_TOKEN_HERE';
const CLIENT_ID = 'YOUR_DISCORD_CLIENT_ID_HERE';

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Define Slash Command
const commands = [
    new SlashCommandBuilder()
        .setName('verify')
        .setDescription('Verify user and fetch device info from Google Sheet')
        .addStringOption(option =>
            option.setName('name')
                .setDescription('Name to search in Column A')
                .setRequired(true))
].map(cmd => cmd.toJSON());

// Register Slash Commands on Bot Ready
client.once('ready', async () => {
    console.log(`Bot online as ${client.user.tag}`);

    const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
    try {
        await rest.put(
            Routes.applicationCommands(CLIENT_ID),
            { body: commands }
        );
        console.log('Slash commands registered successfully.');
    } catch (err) {
        console.error('Failed to register slash commands:', err);
    }
});

// Handle Slash Command Interactions
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'verify') {
        // 1. Immediately tell Discord to wait (prevents "Application didn't respond in time")
        await interaction.deferReply();

        const inputName = interaction.options.getString('name');

        try {
            // Load Google Sheet
            await doc.loadInfo();
            const sheet = doc.sheetsByIndex[0];
            const rows = await sheet.getRows();

            // Match user in Column A ("Name")
            const row = rows.find(r => {
                const sheetName = r.get('Name');
                return sheetName && sheetName.toLowerCase() === inputName.toLowerCase();
            });

            if (row) {
                const name = row.get('Name');
                const role = row.get('Role') || 'Member';
                const robloxUser = row.get('Roblox User') || 'N/A';
                const device = row.get('Device') || 'N/A';

                // 2. Edit deferred reply with fetched data
                await interaction.editReply({
                    content: `✅ **Verification Successful**\n• **Name:** ${name}\n• **Role:** ${role}\n• **Roblox User:** ${robloxUser}\n• **Device:** ${device}`
                });
            } else {
                await interaction.editReply(`❌ User **${inputName}** was not found in the sheet.`);
            }
        } catch (error) {
            console.error('Sheet fetch error:', error);
            await interaction.editReply('❌ An error occurred while fetching data from Google Sheets.');
        }
    }
});

client.login(BOT_TOKEN);
