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
const aboutCommand = {
    type: 1,
    name: 'about',
    description: 'Show information about DL CLAN BOT',
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
for (const item of [command, aboutCommand]) {
    const existing = commands.find(registered => registered.type === 1 && registered.name === item.name);
    const response = await fetch(existing ? `${endpoint}/${existing.id}` : endpoint, {
        method: existing ? 'PATCH' : 'POST',
        headers,
        body: JSON.stringify(item),
    });
    if (!response.ok) {
        throw new Error(`Could not register /${item.name} (${response.status}): ${(await response.text()).slice(0, 500)}`);
    }
}
console.log('Registered /report and /about. Other existing commands were left unchanged.');
