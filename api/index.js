const { Client, GatewayIntentBits } = require('discord.js');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// Import your service account credentials JSON file
const creds = require('./credentials.json'); 

// Authenticate using Google Auth Library
const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Initialize Google Sheet ID (Found in your Sheet URL between /d/ and /edit)
const doc = new GoogleSpreadsheet('YOUR_SHEET_ID_HERE', serviceAccountAuth);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', () => {
    console.log(`Bot logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Command structure: !device DL_AM
    if (message.content.startsWith('!device')) {
        const args = message.content.split(' ');
        const targetName = args[1];

        if (!targetName) {
            return message.reply('Please provide a name. Example: `!device DL_AM`');
        }

        try {
            // Load document properties and worksheets
            await doc.loadInfo();
            const sheet = doc.sheetsByIndex[0];
            const rows = await sheet.getRows();

            // Find user in Column A (Name)
            const row = rows.find(r => r.get('Name')?.toLowerCase() === targetName.toLowerCase());

            if (row) {
                // Get value from Column D (Device)
                const device = row.get('Device') || 'N/A'; 
                const name = row.get('Name');
                
                message.reply(`📱 **${name}** plays on: **${device}**`);
            } else {
                message.reply(`❌ Could not find user **${targetName}** in the sheet.`);
            }
        } catch (error) {
            console.error(error);
            message.reply('There was an error reading the Google Sheet.');
        }
    }
});

client.login('YOUR_DISCORD_BOT_TOKEN');
