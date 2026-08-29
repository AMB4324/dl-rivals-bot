import { google } from 'googleapis';
import { verifyKey } from 'discord-interactions';

// Tell Vercel NOT to pre-parse the body so Discord signature verification works
export const config = {
    api: {
        bodyParser: false,
    },
};

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const RANGE = 'Members!A2:D';

// Helper to read raw request body in Vercel
async function getRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => { resolve(data); });
        req.on('error', err => { reject(err); });
    });
}

// Helper to fetch Google Sheets
async function getSheetMembers() {
    try {
        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: process.env.GOOGLE_CLIENT_EMAIL,
                private_key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
        });

        const sheets = google.sheets({ version: 'v4', auth });
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: RANGE,
        });

        return response.data.values || [];
    } catch (error) {
        console.error('Error fetching Google Sheet:', error);
        return [];
    }
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).send({ error: 'Method not allowed' });
    }

    try {
        const rawBody = await getRawBody(req);
        const signature = req.headers['x-signature-ed25519'];
        const timestamp = req.headers['x-signature-timestamp'];

        const isVerified = verifyKey(rawBody, signature, timestamp, process.env.DISCORD_PUBLIC_KEY);
        if (!isVerified) {
            return res.status(401).send({ error: 'Invalid request signature' });
        }

        const interaction = JSON.parse(rawBody);

        // 1. Handle Discord PING check
        if (interaction.type === 1) {
            return res.status(200).send({ type: 1 }); // PONG
        }

        // 2. Handle Slash Command (/verify) -> Show Modal
        if (interaction.type === 2 && interaction.data.name === 'verify') {
            return res.status(200).send({
                type: 9, // Modal Response type
                data: {
                    custom_id: 'verify_modal',
                    title: 'DL Clan Player Verification',
                    components: [
                        {
                            type: 1, // ActionRow
                            components: [
                                {
                                    type: 4, // Text Input
                                    custom_id: 'display_name_input',
                                    label: 'Enter your real display name:',
                                    style: 1, // Short
                                    placeholder: 'e.g., DL_AM',
                                    required: true,
                                },
                            ],
                        },
                    ],
                },
            });
        }

        // 3. Handle Modal Form Submit
        if (interaction.type === 5 && interaction.data.custom_id === 'verify_modal') {
            const userInput = interaction.data.components[0].components[0].value.trim();
            const rows = await getSheetMembers();

            const matchedMember = rows.find(row => row[0] && row[0].toLowerCase() === userInput.toLowerCase());

            let responseMessage = '';
            if (matchedMember) {
                const [name, role, device] = matchedMember;
                responseMessage = `✅ **Verification Successful!**\nWelcome, **${name}**!\n- **Role:** ${role}\n- **Device:** ${device}`;
            } else {
                responseMessage = `❌ **Verification Failed.** The name **"${userInput}"** could not be found on the official DL Clan roster.`;
            }

            return res.status(200).send({
                type: 4, // Channel message with source
                data: {
                    content: responseMessage,
                    flags: 64, // Ephemeral (only the user sees it)
                },
            });
        }

        return res.status(400).send({ error: 'Unknown interaction' });
    } catch (error) {
        console.error('Server error:', error);
        return res.status(500).send({ error: 'Internal server error' });
    }
}
