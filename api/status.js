import { timingSafeEqual } from 'node:crypto';
import { google } from 'googleapis';

const DISCORD_API = 'https://discord.com/api/v10';
const LOG_SHEET = 'BotLogs';
const LOG_HEADERS = ['Timestamp', 'Level', 'Source', 'Case ID', 'Details'];

function passwordMatches(candidate) {
    const expected = process.env.STATUS_PAGE_PASSWORD;
    if (!expected || typeof candidate !== 'string') return false;

    const candidateBuffer = Buffer.from(candidate);
    const expectedBuffer = Buffer.from(expected);
    return candidateBuffer.length === expectedBuffer.length
        && timingSafeEqual(candidateBuffer, expectedBuffer);
}

function createSheetsClient() {
    google.options({ timeout: 10_000 });
    const auth = new google.auth.GoogleAuth({
        credentials: {
            client_email: process.env.GOOGLE_CLIENT_EMAIL,
            private_key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return google.sheets({ version: 'v4', auth });
}

function errorDetails(error) {
    const code = error?.code || error?.response?.status || error?.status;
    const message = String(error?.message || 'Unknown error')
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .slice(0, 300);
    return code ? `${code}: ${message}` : message;
}

async function ensureLogSheet(sheets) {
    const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        fields: 'sheets.properties.title',
    });
    const exists = spreadsheet.data.sheets?.some(sheet => sheet.properties?.title === LOG_SHEET);
    if (!exists) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: process.env.SPREADSHEET_ID,
            requestBody: { requests: [{ addSheet: { properties: { title: LOG_SHEET } } }] },
        });
    }
    const header = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.SPREADSHEET_ID,
        range: `${LOG_SHEET}!A1:E1`,
    });
    if (!header.data.values?.length) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: `${LOG_SHEET}!A1:E1`,
            valueInputOption: 'RAW',
            requestBody: { values: [LOG_HEADERS] },
        });
    }
}

async function getRecentLogs(sheets) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            range: `${LOG_SHEET}!A2:E`,
        });
        return (response.data.values || []).slice(-20).reverse().map(row => ({
            timestamp: row[0] || '',
            level: row[1] || 'INFO',
            source: row[2] || 'Bot',
            caseId: row[3] || '',
            details: row[4] || '',
        }));
    } catch (error) {
        console.error('Could not read bot diagnostic logs:', error);
        return [];
    }
}

async function checkDiscord() {
    if (!process.env.DISCORD_BOT_TOKEN) {
        return { status: 'not_configured', message: 'DISCORD_BOT_TOKEN is not set in Vercel' };
    }

    try {
        const response = await fetch(`${DISCORD_API}/users/@me`, {
            headers: { authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}` },
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) {
            const details = `Discord API returned HTTP ${response.status}`;
            console.error(`Discord status check failed: ${details}`);
            return { status: 'error', message: details };
        }
        const bot = await response.json();
        return { status: 'ok', message: `Connected as ${bot.username}` };
    } catch (error) {
        const details = errorDetails(error);
        console.error('Discord status check failed:', details);
        return { status: 'error', message: `Could not check Discord: ${details}` };
    }
}

async function checkGoogleSheets() {
    if (!process.env.SPREADSHEET_ID
        || !process.env.GOOGLE_CLIENT_EMAIL
        || !process.env.GOOGLE_PRIVATE_KEY) {
        return {
            status: 'not_configured',
            message: 'Set SPREADSHEET_ID, GOOGLE_CLIENT_EMAIL, and GOOGLE_PRIVATE_KEY in Vercel',
        };
    }

    const result = { status: 'ok', message: 'Members sheet is accessible', reportsReady: false };
    const sheets = createSheetsClient();
    try {
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
        result.reportsReady = titles.has('Reports') && titles.has('Warnings');
    } catch (error) {
        const details = errorDetails(error);
        console.error('Google Sheets read status check failed:', details);
        return {
            status: 'error',
            message: `Could not read the spreadsheet or Members tab: ${details}`,
            logs: await getRecentLogs(sheets),
        };
    }

    try {
        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId: process.env.SPREADSHEET_ID,
            fields: 'sheets.properties.title',
        });
        const titles = new Set(
            (spreadsheet.data.sheets || []).map(sheet => sheet.properties?.title),
        );
        const missingSheets = ['Reports', 'Warnings', LOG_SHEET]
            .filter(title => !titles.has(title));
        if (missingSheets.length) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId: process.env.SPREADSHEET_ID,
                requestBody: {
                    requests: missingSheets.map(title => ({ addSheet: { properties: { title } } })),
                },
            });
        }
        await ensureLogSheet(sheets);
        const existingLogs = await getRecentLogs(sheets);
        const latestLog = existingLogs[0];
        if (latestLog?.source !== 'Status check' || latestLog.details !== 'Dashboard check completed') {
            await sheets.spreadsheets.values.append({
                spreadsheetId: process.env.SPREADSHEET_ID,
                range: `${LOG_SHEET}!A:E`,
                valueInputOption: 'RAW',
                insertDataOption: 'INSERT_ROWS',
                requestBody: {
                    values: [[new Date().toISOString(), 'INFO', 'Status check', '', 'Dashboard check completed']],
                },
            });
        }
        result.writeAccess = { status: 'ok', message: 'Service account can create tabs and write rows' };
        result.reportsReady = true;
    } catch (error) {
        const details = errorDetails(error);
        console.error('Google Sheets write status check failed:', details);
        result.status = 'error';
        result.writeAccess = {
            status: 'error',
            message: `Cannot create/write report tabs. Share the spreadsheet with ${process.env.GOOGLE_CLIENT_EMAIL} as Editor. Error: ${details}`,
        };
    }
    result.logs = await getRecentLogs(sheets);
    return result;
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

    const [discord, googleSheets] = await Promise.all([
        checkDiscord(),
        checkGoogleSheets(),
    ]);
    const statuses = { discord, googleSheets };
    const allRequiredServicesResponding = discord.status === 'ok'
        && googleSheets.status === 'ok';
    return res.status(200).json({
        checkedAt: new Date().toISOString(),
        overall: allRequiredServicesResponding ? 'working' : 'issues',
        services: statuses,
        reportSheetsReady: googleSheets.reportsReady ?? false,
        logs: googleSheets.logs || [],
    });
}
