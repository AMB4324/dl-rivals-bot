const required = ['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID'];
for (const name of required) {
    if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const endpoint = `https://discord.com/api/v10/applications/${process.env.DISCORD_APPLICATION_ID}/guilds/${process.env.DISCORD_GUILD_ID}/commands`;
const command = {
    type: 1,
    name: 'report',
    description: 'Submit a report with a description and screenshot',
    options: [
        {
            type: 6,
            name: 'member',
            description: 'The server member you are reporting',
            required: true,
        },
        {
            type: 3,
            name: 'description',
            description: 'Explain what happened',
            required: true,
            max_length: 1000,
        },
        {
            type: 11,
            name: 'evidence',
            description: 'Screenshot or image evidence (PNG, JPEG, or WebP; max 10 MB)',
            required: true,
        },
    ],
};

const headers = {
    authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    'content-type': 'application/json',
};
const listResponse = await fetch(endpoint, { headers });
if (!listResponse.ok) {
    throw new Error(`Could not read guild commands (${listResponse.status}): ${(await listResponse.text()).slice(0, 500)}`);
}
const commands = await listResponse.json();
const existing = commands.find(item => item.type === 1 && item.name === command.name);
const response = await fetch(existing ? `${endpoint}/${existing.id}` : endpoint, {
    method: existing ? 'PATCH' : 'POST',
    headers,
    body: JSON.stringify(command),
});
if (!response.ok) {
    throw new Error(`Could not register /report (${response.status}): ${(await response.text()).slice(0, 500)}`);
}
console.log('Registered /report for the configured Discord server. Existing commands were left unchanged.');
