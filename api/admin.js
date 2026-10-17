import { timingSafeEqual } from 'node:crypto';

const DISCORD_API = 'https://discord.com/api/v10';

function passwordMatches(candidate) {
    const expected = process.env.STATUS_PAGE_PASSWORD;
    if (!expected || typeof candidate !== 'string') return false;
    const left = Buffer.from(candidate);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
}

async function discordRequest(path, options = {}) {
    const response = await fetch(`${DISCORD_API}${path}`, {
        ...options,
        signal: AbortSignal.timeout(10_000),
        headers: {
            authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            ...(options.body ? { 'content-type': 'application/json' } : {}),
        },
    });
    if (!response.ok) {
        const details = (await response.text()).slice(0, 300);
        throw new Error(`Discord API returned ${response.status}: ${details}`);
    }
    if (response.status === 204) return null;
    return response.json();
}

function validateChannel(channelId, channels) {
    const channel = channels.find(item => item.id === channelId);
    if (!channel || channel.type !== 0) {
        throw new Error('Choose a text channel the bot can access.');
    }
    return channel;
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Method not allowed' });
    }
    if (!passwordMatches(req.body?.password)) {
        return res.status(401).json({ error: 'Incorrect panel password.' });
    }
    if (!process.env.DISCORD_BOT_TOKEN || !process.env.DISCORD_GUILD_ID) {
        return res.status(503).json({ error: 'Discord bot configuration is missing in Vercel.' });
    }

    try {
        const channels = await discordRequest(`/guilds/${process.env.DISCORD_GUILD_ID}/channels`);
        if (req.body.action === 'channels') {
            return res.status(200).json({
                channels: channels
                    .filter(channel => channel.type === 0)
                    .map(({ id, name, parent_id: parentId }) => ({ id, name, parentId })),
            });
        }

        if (req.body.action === 'send-message') {
            const channel = validateChannel(req.body.channelId, channels);
            const content = typeof req.body.content === 'string' ? req.body.content.trim() : '';
            if (!content || content.length > 2000) {
                return res.status(400).json({ error: 'Message must be between 1 and 2000 characters.' });
            }
            await discordRequest(`/channels/${channel.id}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    content,
                    allowed_mentions: { parse: [] },
                }),
            });
            return res.status(200).json({ message: `Message sent to #${channel.name}.` });
        }

        if (req.body.action === 'publish-ticket-panel') {
            const channel = validateChannel(req.body.channelId, channels);
            const configuredTicketCategory = process.env.REPORT_CATEGORY_ID;
            if (!configuredTicketCategory) {
                return res.status(503).json({ error: 'Set REPORT_CATEGORY_ID in Vercel before publishing tickets.' });
            }
            await discordRequest(`/channels/${channel.id}/messages`, {
                method: 'POST',
                body: JSON.stringify({
                    content: 'Need to report a player? Open a private report ticket below. Use `/report` inside your ticket to submit the member, details, and screenshot.',
                    components: [{
                        type: 1,
                        components: [{
                            type: 2,
                            style: 1,
                            label: 'Open a report ticket',
                            custom_id: 'open_report_ticket',
                        }],
                    }],
                    allowed_mentions: { parse: [] },
                }),
            });
            return res.status(200).json({ message: `Ticket panel posted in #${channel.name}.` });
        }

        return res.status(400).json({ error: 'Unknown admin action.' });
    } catch (error) {
        console.error('Admin panel action failed:', error);
        return res.status(500).json({ error: error.message || 'Admin action failed.' });
    }
}
