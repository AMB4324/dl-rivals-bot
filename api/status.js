import { timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';

const DISCORD_API = 'https://discord.com/api/v10';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

function passwordMatches(candidate) {
    const expected = process.env.STATUS_PAGE_PASSWORD;
    if (!expected || typeof candidate !== 'string') return false;

    const candidateBuffer = Buffer.from(candidate);
    const expectedBuffer = Buffer.from(expected);
    return candidateBuffer.length === expectedBuffer.length
        && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function createSheetsClient() {
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    return google.sheets({ version: 'v4', auth });
}

async function checkDiscord() {
    if (!process.env.DISCORD_BOT_TOKEN) {
        return { status: 'not_configured', message: 'Bot token is not set' };
    }

    try {
        const response = await fetch(`${DISCORD_API}/users/@me`, {
            headers: { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
            console.error(`Discord status check failed (HTTP ${response.status})`);
            return { status: 'error', message: 'Discord rejected the bot token' };
        }
        const bot = await response.json();
        return { status: 'ok', message: `Connected as ${bot.username}` };
    } catch (error) {
        console.error('Discord status check failed:', error);
        return { status: 'error', message: 'Could not reach Discord API' };
    }
}

async function checkGoogleSheets() {
    if (!process.env.SPREADSHEET_ID
        || !process.env.GOOGLE_CLIENT_EMAIL
        || !process.env.GOOGLE_PRIVATE_KEY) {
        return { status: 'not_configured', message: 'Google Sheets credentials are incomplete' };
    }

    try {
        const sheets = createSheetsClient();
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            fields: 'sheets.properties.title',
        });
        const titles = new Set(
            (spreadsheet.data.sheets || []).map(sheet => sheet.properties?.title),
        );
        await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: 'Members!A1:A1',
        });
        return {
            status: 'ok',
            message: 'Members sheet is accessible',
            reportsReady: titles.has('Reports') && titles.has('Warnings'),
        };
    } catch (error) {
        console.error('Google Sheets status check failed:', error);
        return { status: 'error', message: 'Could not read the configured spreadsheet' };
    }
}

async function checkGemini() {
    if (!process.env.GEMINI_API_KEY) {
        return { status: 'optional', message: 'No API key set; reports require manual image review' };
    }

    try {
        const response = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}`,
            {
                headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY },
                signal: AbortSignal.timeout(8000),
            },
        );
        if (!response.ok) {
            console.error(`Gemini status check failed (HTTP ${response.status})`);
            return { status: 'error', message: 'Gemini API key or model could not be verified' };
        }
        return { status: 'ok', message: `${GEMINI_MODEL} is reachable` };
    } catch (error) {
        console.error('Gemini status check failed:', error);
        return { status: 'error', message: 'Could not reach Gemini API' };
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }

    if (!process.env.STATUS_PAGE_PASSWORD) {
        console.error('STATUS_PAGE_PASSWORD is not configured');
        return res.status(503).json({ error: 'Status page access is not configured' });
    }

    if (!passwordMatches(req.body?.password)) {
        return res.status(401).json({ error: 'Incorrect password' });
    }

    const [discord, googleSheets, gemini] = await Promise.all([
        checkDiscord(),
        checkGoogleSheets(),
        checkGemini(),
    ]);
    const statuses = { discord, googleSheets, gemini };
    const allRequiredServicesResponding = discord.status === 'ok'
        && googleSheets.status === 'ok'
        && gemini.status !== 'error';
    return res.status(200).json({
        checkedAt: new Date().toISOString(),
        overall: allRequiredServicesResponding ? 'working' : 'issues',
        services: statuses,
        reportSheetsReady: googleSheets.reportsReady ?? false,
    });
}
