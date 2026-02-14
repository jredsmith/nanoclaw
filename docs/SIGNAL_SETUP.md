# Signal Setup Guide

Set up Signal as the messaging channel for NanoClaw on a new system.

## Prerequisites

- **Node.js** (v20+) and npm
- **Java** (JRE 21+) — required by signal-cli
- A **dedicated phone number** for the bot (can be a VoIP number that receives SMS or voice calls)

## 1. Install signal-cli

### macOS (Homebrew)

```bash
brew install signal-cli
```

### Linux

Download the latest release from https://github.com/AsamK/signal-cli/releases:

```bash
VERSION=0.13.12  # check for latest
wget https://github.com/AsamK/signal-cli/releases/download/v${VERSION}/signal-cli-${VERSION}.tar.gz
tar xf signal-cli-${VERSION}.tar.gz -C /opt
ln -sf /opt/signal-cli-${VERSION}/bin/signal-cli /usr/local/bin/signal-cli
```

Verify it's installed:

```bash
signal-cli --version
```

## 2. Register your phone number

Set the phone number (with country code):

```bash
export SIGNAL_PHONE_NUMBER=+14155551234
```

Request a verification code via voice call (recommended — more reliable than SMS for VoIP numbers):

```bash
npm run auth:register
```

This runs `signal-cli register --voice`. You'll receive a call with a 6-digit code.

To use SMS instead, edit the script or run directly:

```bash
SIGNAL_PHONE_NUMBER=+14155551234 npx tsx src/signal-auth.ts register --sms
```

## 3. Verify

Enter the code you received:

```bash
SIGNAL_PHONE_NUMBER=+14155551234 npm run auth:verify -- 123456
```

Check that authentication succeeded:

```bash
SIGNAL_PHONE_NUMBER=+14155551234 npm run auth:status
```

You should see `Status: authenticated` and a list of groups (possibly empty).

Auth credentials are stored in `store/signal-auth/`.

## 4. Set environment variables

Add to your shell profile (`~/.zshrc`, `~/.bashrc`, or `.env`):

```bash
export SIGNAL_PHONE_NUMBER=+14155551234
```

Optional overrides:

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNAL_PHONE_NUMBER` | *(required)* | Bot's registered phone number |
| `SIGNAL_CLI_PATH` | `signal-cli` | Path to signal-cli binary |
| `ASSISTANT_NAME` | `Andy` | Name prefixed to outbound messages |

## 5. Create a Signal group

1. Open Signal on your personal phone
2. Create a new group and add the bot's phone number
3. Send a message in the group (this lets NanoClaw discover it)
4. Start NanoClaw: `npm run dev`
5. The group will appear in `data/available_groups.json` after the first message

## 6. Register the group with NanoClaw

Register your main group (the one where you talk to the bot directly). This is done via the main group's container — on first run, use the setup skill or register manually by adding an entry to `store/registered_groups.json`:

```json
{
  "signal-group:<groupId>": {
    "name": "My Group",
    "folder": "main",
    "trigger": "@Andy",
    "added_at": "2024-01-01T00:00:00.000Z"
  }
}
```

The `<groupId>` is the base64 group identifier that appears in `data/available_groups.json`.

## 7. Run

```bash
npm run dev     # development (hot reload)
npm run build && npm start  # production
```

## Troubleshooting

### signal-cli won't start

- Check Java is installed: `java -version` (needs JRE 21+)
- Check signal-cli is on PATH: `which signal-cli`
- If using a custom path: `export SIGNAL_CLI_PATH=/path/to/signal-cli`

### Registration fails

- The phone number must include country code (e.g., `+1` for US)
- Some VoIP providers block Signal registration — try a different number
- If SMS doesn't arrive, try `--voice` for a phone call instead
- Rate limiting: wait 24 hours if you've attempted too many registrations

### "daemon did not become ready" on startup

- Verify registration: `npm run auth:status`
- Check that no other signal-cli process is running for this number
- Look at stderr output: the daemon logs Java errors there

### Messages not arriving

- Confirm the bot's number is added to the Signal group
- Send a message in the group after starting NanoClaw (triggers metadata sync)
- Check `data/available_groups.json` — the group should be listed
- Verify the group is registered in `store/registered_groups.json`

### Signal message length limit

Signal has a ~6000 character limit per message. NanoClaw automatically splits long responses at paragraph/sentence boundaries (max 5900 chars per chunk).

## Auth credentials

All Signal auth data lives in `store/signal-auth/`. To migrate to a new machine, copy this directory along with `store/registered_groups.json` and `store/nanoclaw.db`.
