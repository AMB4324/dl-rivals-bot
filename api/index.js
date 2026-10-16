import { randomUUID } from 'node:crypto';
import { google } from 'googleapis';
import { verifyKey } from 'discord-interactions';

// Tell Vercel NOT to pre-parse the body so Discord signature verification works
export const config = {
    api: {
        bodyParser: false,
    },
};

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const MEMBER_RANGE = 'Members!A2:D';
const WARNING_SHEET = 'Warnings';
const REPORT_SHEET = 'Reports';
const LOG_SHEET = 'BotLogs';
const LOG_HEADERS = ['Timestamp', 'Level', 'Source', 'Case ID', 'Details'];
const WARNING_DURATIONS_MS = [60 * 60 * 1000, 24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];
const WARNING_LABELS = ['1 hour', '24 hours', '7 days'];
const WARNING_HEADERS = [
    'Case ID', 'Timestamp', 'Guild ID', 'Ticket Channel ID', 'Reporter ID',
    'Target ID', 'Target Username', 'Warning Number', 'Timeout Duration (ms)',
    'Description', 'Image URL', 'Analysis', 'Approved By',
];
const REPORT_HEADERS = [
    'Case ID', 'Status', 'Guild ID', 'Ticket Channel ID', 'Reporter ID',
    'Target ID', 'Target Username', 'Description', 'Image URL',
    'Analysis Summary', 'Potential Abuse', 'Confidence', 'Created At', 'Approved By',
];
const DISCORD_API = 'https://discord.com/api/v10';

function getRawBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => { resolve(data); });
        req.on('error', reject);
    });
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

async function logBotError(source, error, caseId = '') {
    const details = String(error?.message || error || 'Unknown error')
        .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
        .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
        .slice(0, 500);
    console.error(`[${source}]${caseId ? ` [${caseId}]` : ''}`, details);

    try {
        const sheets = createSheetsClient();
        await ensureSheet(sheets, LOG_SHEET, LOG_HEADERS);
        await appendRow(sheets, LOG_SHEET, 'E', [
            new Date().toISOString(),
            'ERROR',
            source,
            caseId,
            details,
        ]);
    } catch (loggingError) {
        console.error('Could not save diagnostic to BotLogs sheet:', loggingError);
    }
}

async function getSheetMembers() {
    try {
        const response = await createSheetsClient().spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: MEMBER_RANGE,
        });
        return response.data.values || [];
    } catch (error) {
        await logBotError('Verification: Google Sheets read', error);
        return [];
    }
}

function columnName(columnNumber) {
    let result = '';
    let number = columnNumber;
    while (number > 0) {
        const remainder = (number - 1) % 26;
        result = String.fromCharCode(65 + remainder) + result;
        number = Math.floor((number - 1) / 26);
    }
    return result;
}

async function ensureSheet(sheets, title, headers) {
    const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: SPREADSHEET_ID,
        fields: 'sheets.properties.title',
    });
    const exists = spreadsheet.data.sheets?.some(sheet => sheet.properties?.title === title);
    if (!exists) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: { requests: [{ addSheet: { properties: { title } } }] },
        });
    }

    const lastColumn = columnName(headers.length);
    const header = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${title}!A1:${lastColumn}1`,
    });
    if (!header.data.values?.length) {
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${title}!A1:${lastColumn}1`,
            valueInputOption: 'RAW',
            requestBody: { values: [headers] },
        });
    }
}

async function getRows(sheets, title, lastColumn) {
    const response = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `${title}!A2:${lastColumn}`,
    });
    return response.data.values || [];
}

async function appendRow(sheets, title, lastColumn, values) {
    await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${title}!A:${lastColumn}`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [values] },
    });
}

async function discordRequest(path, options = {}) {
    const response = await fetch(`${DISCORD_API}${path}`, {
        ...options,
        signal: options.signal || AbortSignal.timeout(10_000),
        headers: {
            authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            ...(options.body ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
        },
    });
    if (!response.ok) {
        const message = await response.text();
        throw new Error(`Discord API request failed (${response.status}): ${message.slice(0, 500)}`);
    }
    if (response.status === 204) return null;
    return response.json();
}

async function webhookRequest(applicationId, token, path, method, body) {
    const response = await fetch(`${DISCORD_API}/webhooks/${applicationId}/${token}${path}`, {
        method,
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        const message = await response.text();
        throw new Error(`Discord interaction follow-up failed (${response.status}): ${message.slice(0, 500)}`);
    }
}

function getOption(options, name) {
    return options?.find(option => option.name === name)?.value;
}

async function handleReport(interaction, res) {
    const options = interaction.data.options || [];
    const targetId = getOption(options, 'member');
    const description = getOption(options, 'description')?.trim();
    const evidenceId = getOption(options, 'evidence');
    const attachment = interaction.data.resolved?.attachments?.[evidenceId];

    if (!interaction.guild_id || interaction.guild_id !== process.env.DISCORD_GUILD_ID) {
        return res.status(200).send({
            type: 4,
            data: { content: 'Reports can only be submitted in this server.', flags: 64 },
        });
    }
    if (!targetId || !description || !attachment) {
        return res.status(200).send({
            type: 4,
            data: { content: 'Please provide the reported member, a description, and an image.', flags: 64 },
        });
    }

    res.status(200).send({
        type: 4,
        data: {
            content: 'Report received. I’m sending the details to a moderator for review.',
            flags: 64,
        },
    });

    let moderatorDm;
    let reportMessage;
    let caseId;
    try {
        const channel = await discordRequest(`/channels/${interaction.channel_id}`);
        if (channel.parent_id !== process.env.REPORT_CATEGORY_ID) {
            throw new Error('Use /report inside a report ticket channel.');
        }
        const target = await discordRequest(`/guilds/${interaction.guild_id}/members/${targetId}`);
        if (targetId === interaction.member?.user?.id) {
            throw new Error('You cannot report yourself.');
        }
        if (target.user.bot) {
            throw new Error('Bot accounts cannot be reported by this workflow.');
        }
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(attachment.content_type)) {
            throw new Error('Evidence must be a PNG, JPEG, or WebP image.');
        }
        if (Number(attachment.size) > 10 * 1024 * 1024) {
            throw new Error('Evidence image must be 10 MB or smaller.');
        }
        caseId = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
        moderatorDm = await discordRequest('/users/@me/channels', {
            method: 'POST',
            body: JSON.stringify({ recipient_id: process.env.MODERATOR_USER_ID }),
        });
        reportMessage = await discordRequest(`/channels/${moderatorDm.id}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                content: [
                    `**Report case ${caseId}**`,
                    `Ticket: <#${interaction.channel_id}>`,
                    `Reported member: ${target.user.username} (\`${targetId}\`)`,
                    `Reporter ID: \`${interaction.member.user.id}\``,
                    `Description: ${description.slice(0, 1000)}`,
                    '',
                    'Saving this report for approval. Please review the screenshot manually.',
                ].join('\n'),
                embeds: [{ image: { url: attachment.url } }],
                allowed_mentions: { parse: [] },
            }),
        });

        const sheets = createSheetsClient();
        await ensureSheet(sheets, REPORT_SHEET, REPORT_HEADERS);
        await ensureSheet(sheets, WARNING_SHEET, WARNING_HEADERS);
        await appendRow(sheets, REPORT_SHEET, 'N', [
            caseId,
            'PENDING',
            interaction.guild_id,
            interaction.channel_id,
            interaction.member.user.id,
            targetId,
            target.user.username,
            description.slice(0, 1000),
            attachment.url,
            'Manual review; no AI analysis',
            'Not analyzed',
            '',
            new Date().toISOString(),
            '',
        ]);

        await discordRequest(`/channels/${moderatorDm.id}/messages/${reportMessage.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
                components: [{
                    type: 1,
                    components: [{
                        type: 2,
                        style: 3,
                        label: 'Approve warning and timeout',
                        custom_id: `approve_report:${caseId}`,
                    }],
                }],
            }),
        });
        await webhookRequest(interaction.application_id, interaction.token, '/messages/@original', 'PATCH', {
            content: `Your report (\`${caseId}\`) has been sent to a moderator for review.`,
        });
    } catch (error) {
        await logBotError('Report submission', error, caseId || '');
        if (moderatorDm && reportMessage && caseId) {
            await discordRequest(`/channels/${moderatorDm.id}/messages/${reportMessage.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    content: `**Report case ${caseId} could not be queued for approval.**\nThe screenshot was delivered, but saving the case failed. Do not approve it until the Reports sheet has been checked.`,
                    components: [],
                }),
            }).catch(updateError => console.error('Could not annotate unqueued moderator report DM:', updateError));
        }
        await webhookRequest(interaction.application_id, interaction.token, '/messages/@original', 'PATCH', {
            content: `I could not finish sending this report: ${error.message || 'unknown error'}. Please contact a moderator.`,
        }).catch(followupError => console.error('Could not update report response:', followupError));
    }
}

async function handleApproval(interaction, res) {
    const caseId = interaction.data.custom_id.slice('approve_report:'.length);
    if (interaction.member?.user?.id !== process.env.MODERATOR_USER_ID
        && interaction.user?.id !== process.env.MODERATOR_USER_ID) {
        return res.status(200).send({
            type: 4,
            data: { content: 'Only the configured moderator can approve reports.', flags: 64 },
        });
    }

    res.status(200).send({ type: 5, data: { flags: 64 } });
    const sheets = createSheetsClient();
    let reportRowNumber;
    let report;
    let timeoutApplied = false;
    try {
        await ensureSheet(sheets, REPORT_SHEET, REPORT_HEADERS);
        await ensureSheet(sheets, WARNING_SHEET, WARNING_HEADERS);
        const reports = await getRows(sheets, REPORT_SHEET, 'N');
        const index = reports.findIndex(row => row[0] === caseId);
        if (index < 0) throw new Error('Report case not found.');
        reportRowNumber = index + 2;
        report = reports[index];
        if (report[1] !== 'PENDING') throw new Error(`This report is already ${String(report[1]).toLowerCase()}.`);

        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${REPORT_SHEET}!B${reportRowNumber}`,
            valueInputOption: 'RAW',
            requestBody: { values: [['PROCESSING']] },
        });

        const [caseIdValue, , guildId, channelId, reporterId, targetId, targetUsername, description, imageUrl, summary] = report;
        const warnings = await getRows(sheets, WARNING_SHEET, 'M');
        const warningNumber = warnings.filter(row => row[5] === targetId).length + 1;
        const scheduleIndex = Math.min(warningNumber - 1, WARNING_DURATIONS_MS.length - 1);
        const timeoutMs = WARNING_DURATIONS_MS[scheduleIndex];
        const member = await discordRequest(`/guilds/${guildId}/members/${targetId}`);
        if (member.user.bot) throw new Error('Bot accounts cannot be warned by this workflow.');
        const timeoutUntil = new Date(Date.now() + timeoutMs).toISOString();
        await discordRequest(`/guilds/${guildId}/members/${targetId}`, {
            method: 'PATCH',
            body: JSON.stringify({
                communication_disabled_until: timeoutUntil,
            }),
            headers: { 'x-audit-log-reason': encodeURIComponent(`Approved report ${caseIdValue}; warning ${warningNumber}`) },
        });
        timeoutApplied = true;

        await appendRow(sheets, WARNING_SHEET, 'M', [
            caseIdValue,
            new Date().toISOString(),
            guildId,
            channelId,
            reporterId,
            targetId,
            targetUsername,
            warningNumber,
            timeoutMs,
            description,
            imageUrl,
            summary,
            process.env.MODERATOR_USER_ID,
        ]);
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${REPORT_SHEET}!B${reportRowNumber}:N${reportRowNumber}`,
            valueInputOption: 'RAW',
            requestBody: { values: [['APPROVED', ...report.slice(2, 12), new Date().toISOString(), process.env.MODERATOR_USER_ID]] },
        });

        let dmStatus = 'A warning DM was sent.';
        try {
            const dm = await discordRequest('/users/@me/channels', {
                method: 'POST',
                body: JSON.stringify({ recipient_id: targetId }),
            });
            await discordRequest(`/channels/${dm.id}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    content: `You have received warning ${warningNumber} following moderator review of report ${caseIdValue}. You have been timed out for ${WARNING_LABELS[scheduleIndex]}. Please follow the server rules.`,
                    allowed_mentions: { parse: [] },
                }),
            });
        } catch (error) {
            console.error(`Could not DM warning to member ${targetId}:`, error);
            dmStatus = 'I could not DM the member (they may have DMs disabled).';
        }

        await webhookRequest(interaction.application_id, interaction.token, '/messages/@original', 'PATCH', {
            content: `Approved case ${caseIdValue}. Warning ${warningNumber} logged; timeout: ${WARNING_LABELS[scheduleIndex]}. ${dmStatus}`,
        });
    } catch (error) {
        await logBotError('Report approval', error, caseId);
        if (reportRowNumber && report?.[1] === 'PENDING') {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${REPORT_SHEET}!B${reportRowNumber}`,
                valueInputOption: 'RAW',
                requestBody: {
                    values: [[timeoutApplied ? 'ACTION_APPLIED_LOG_FAILED' : 'PENDING']],
                },
            }).catch(updateError => console.error('Could not restore pending report status:', updateError));
        }
        await webhookRequest(interaction.application_id, interaction.token, '/messages/@original', 'PATCH', {
            content: timeoutApplied
                ? 'The timeout was applied, but I could not finish recording the warning. The case was locked to prevent duplicate action; please reconcile the Warnings tab manually.'
                : (error.message || 'Approval failed. Check the bot permissions and report sheet.'),
        }).catch(followupError => console.error('Could not update approval response:', followupError));
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
        if (!isVerified) return res.status(401).send({ error: 'Invalid request signature' });

        const interaction = JSON.parse(rawBody);
        if (interaction.type === 1) return res.status(200).send({ type: 1 });

        if (interaction.type === 2 && interaction.data.name === 'verify') {
            return res.status(200).send({
                type: 9,
                data: {
                    custom_id: 'verify_modal',
                    title: 'DL Clan Player Verification',
                    components: [{
                        type: 1,
                        components: [{
                            type: 4,
                            custom_id: 'display_name_input',
                            label: 'Enter your real display name:',
                            style: 1,
                            placeholder: 'e.g., DL_AM',
                            required: true,
                        }],
                    }],
                },
            });
        }

        if (interaction.type === 2 && interaction.data.name === 'report') {
            return await handleReport(interaction, res);
        }

        if (interaction.type === 3 && interaction.data.custom_id.startsWith('approve_report:')) {
            return await handleApproval(interaction, res);
        }

        if (interaction.type === 5 && interaction.data.custom_id === 'verify_modal') {
            const userInput = interaction.data.components[0].components[0].value.trim();
            const rows = await getSheetMembers();
            const matchedMember = rows.find(row => row[0] && row[0].toLowerCase() === userInput.toLowerCase());

            const responseMessage = matchedMember
                ? `✅ **Verification Successful!**\nWelcome, **${matchedMember[0]}**!\n- **Role:** ${matchedMember[1]}\n- **Device:** ${matchedMember[2]}`
                : `❌ **Verification Failed.** The name **"${userInput}"** could not be found on the official DL Clan roster.`;

            return res.status(200).send({
                type: 4,
                data: { content: responseMessage, flags: 64 },
            });
        }

        return res.status(400).send({ error: 'Unknown interaction' });
    } catch (error) {
        await logBotError('Discord interaction handler', error);
        return res.status(500).send({ error: 'Internal server error' });
    }
}
