# DL Clan Discord bot

The bot runs entirely as Discord interactions handled by the Vercel function at `api/index.js`. `/verify` continues to use the existing `Members` Google Sheets tab. Reports use a separate `/report` command and `Reports`/`Warnings` tabs.

## Configure Vercel

Set these environment variables in the Vercel project:

- `DISCORD_PUBLIC_KEY`: Discord application's public key, used to verify interaction requests.
- `DISCORD_BOT_TOKEN`: bot token, used to send moderator/member DMs and apply timeouts.
- `DISCORD_APPLICATION_ID`: Discord application ID.
- `DISCORD_GUILD_ID`: server ID that receives the `/report` command.
- `REPORT_CATEGORY_ID`: category ID containing Ticket Tool report channels.
- `MODERATOR_USER_ID`: the only Discord user allowed to approve reports.
- `SPREADSHEET_ID`, `GOOGLE_CLIENT_EMAIL`, `GOOGLE_PRIVATE_KEY`: Google service-account details. Share the spreadsheet with the service account and give it edit access. The `Members` roster remains unchanged; the function creates separate `Reports` and `Warnings` tabs.
- `GEMINI_API_KEY` (optional): Google Gemini API key for screenshot review. If omitted, reports are still sent for manual review.
- `GEMINI_MODEL` (optional): model name; defaults to `gemini-2.0-flash`.
- `STATUS_PAGE_PASSWORD`: password for the private status dashboard at `/status.html`. Store this only in Vercel environment variables; do not put it in GitHub or a frontend file.

Use Node.js 18 or newer. The original verification flow only needs its existing Discord and Google Sheets settings; report settings are needed when enabling reports.

## Configure Discord

1. In the Discord Developer Portal, set the application's **Interactions Endpoint URL** to the deployed Vercel URL ending in `/api` (for example, `https://your-project.vercel.app/api`). Discord verifies the endpoint with a PING request.
2. Invite the application with `bot` and `applications.commands` scopes. Give the bot View Channels, Moderate Members, and permission to send messages in report-ticket channels and in DMs. Its role must be above members it may timeout.
3. Register `/report` by running `npm install` and then `npm run register:commands` with `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, and `DISCORD_GUILD_ID` available in your local environment. The script creates or updates only `/report`; it does not replace the existing `/verify` command.
4. Set `REPORT_CATEGORY_ID` to the category where Ticket Tool creates report tickets. Users run `/report` inside their ticket and provide the member, description, and screenshot in one command.

The report is stored as pending in the `Reports` sheet and sent to the configured moderator in a DM with an approval button. The image assessment is advisory only. Pressing **Approve warning and timeout** applies an escalating timeout (1 hour, then 24 hours, then 7 days for the third and later approved warnings), logs it in the `Warnings` tab, and DMs the reported member. Vercel does not need to keep a process running; report submission and approval each invoke the interaction endpoint.

## Private status dashboard

Open `https://your-project.vercel.app/status.html` and enter the `STATUS_PAGE_PASSWORD`. The password is checked by a Vercel API function and is not embedded in the page or repository. The dashboard checks the Discord bot token, the Google Sheets roster access, and (if configured) Gemini API access. Gemini may be omitted because image analysis is optional. The Reports and Warnings tabs are created on the first report; their absence before then is shown as pending, not as an outage.
