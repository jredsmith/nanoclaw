# NanoClaw Setup Guide

Follow these steps in order. Each step builds on the previous one.

---

## 1. Install Dependencies

```bash
cd /Users/jaredsmith/NanoClaw/nanoclaw
npm install
```

## 2. Install Container Runtime

You're on macOS, so you have two options:

### Option A: Apple Container (Recommended for Apple Silicon)

1. Download the latest `.pkg` from https://github.com/apple/container/releases
2. Double-click to install
3. Start the service:
   ```bash
   container system start
   container --version
   ```

### Option B: Docker

1. Install [Docker Desktop](https://docker.com/products/docker-desktop)
2. Launch it and verify:
   ```bash
   docker info
   ```
3. Come back to Claude Code and run `/setup` — choose Docker when prompted, and it will run the `/convert-to-docker` skill to adapt the codebase.

## 3. Configure Claude Authentication

You need either a Claude subscription token or an Anthropic API key.

### Option A: Claude Subscription (Pro/Max) — Recommended

1. In a terminal, run:
   ```bash
   claude setup-token
   ```
2. A browser window will open — log in and copy the token displayed.
3. Create a `.env` file in the project root:
   ```bash
   echo "CLAUDE_CODE_OAUTH_TOKEN=<your-token-here>" > .env
   ```

### Option B: Anthropic API Key

1. Get a key from https://console.anthropic.com/
2. Create a `.env` file in the project root:
   ```bash
   echo "ANTHROPIC_API_KEY=<your-key-here>" > .env
   ```
3. Verify:
   ```bash
   grep "^ANTHROPIC_API_KEY=" .env | cut -d= -f2 | cut -c1-7
   ```
   You should see the first 7 characters of your key.

## 4. Build the Container Image

```bash
./container/build.sh
```

This creates the `nanoclaw-agent:latest` image with Node.js, Chromium, Claude Code CLI, and browser automation.

Verify the build:

**Apple Container:**
```bash
echo '{}' | container run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK"
```

**Docker:**
```bash
echo '{}' | docker run -i --entrypoint /bin/echo nanoclaw-agent:latest "Container OK"
```

You should see `Container OK`.

## 5. Authenticate WhatsApp

### Option A: QR Code in Browser (Recommended)

1. Clean any stale auth state:
   ```bash
   rm -rf store/auth store/qr-data.txt store/auth-status.txt
   ```
2. Start the auth process:
   ```bash
   npm run auth
   ```
3. A QR code will appear. Scan it with WhatsApp:
   - Open WhatsApp on your phone
   - Go to **Settings → Linked Devices → Link a Device**
   - Scan the QR code

### Option B: Pairing Code (No Camera Needed)

1. Clean any stale auth state:
   ```bash
   rm -rf store/auth store/qr-data.txt store/auth-status.txt
   ```
2. Run with your phone number (country code, no `+` or spaces, e.g. `14155551234`):
   ```bash
   npx tsx src/whatsapp-auth.ts --pairing-code --phone YOUR_PHONE_NUMBER
   ```
3. You'll see a pairing code like `ABC12DEF`. On your phone:
   - Open WhatsApp → **Settings → Linked Devices → Link a Device**
   - Tap **"Link with phone number instead"**
   - Enter the code

Wait for the terminal to say "Successfully authenticated" before continuing.

## 6. Configure Assistant Name and Main Channel

### 6a. Choose a Trigger Word

The default is `Andy`. In group chats, messages starting with `@Andy` get sent to Claude. In your main channel, no prefix is needed.

### 6b. Choose Your Main Channel

Your **main channel** is your admin control portal with elevated privileges:
- Can see messages from ALL other registered groups
- Can manage and delete tasks across all groups
- Has read-write access to the entire NanoClaw project

**Recommended:** Use your personal "Message Yourself" chat or a solo WhatsApp group.

### 6c. Register the Main Channel

1. Build and run briefly to sync WhatsApp groups:
   ```bash
   npm run build
   npm run dev
   ```
   Wait ~10 seconds for groups to sync, then press `Ctrl+C` to stop.

2. **If using a personal chat (Message Yourself):**
   Your JID is your phone number formatted as `YOURNUMBER@s.whatsapp.net` (e.g. `14155551234@s.whatsapp.net`).

3. **If using a group:**
   Look up available groups:
   ```bash
   sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE '%@g.us' ORDER BY last_message_time DESC LIMIT 20"
   ```

4. Create the registration file (replace values as needed):
   ```bash
   mkdir -p data
   mkdir -p groups/main/logs
   ```

5. Create `data/registered_groups.json` with your JID and trigger word:

   ```json
   {
     "YOUR_JID_HERE": {
       "name": "main",
       "folder": "main",
       "trigger": "@Andy",
       "added_at": "2026-02-15T00:00:00.000Z",
       "requiresTrigger": false
     }
   }
   ```

   - For personal chats / solo groups: set `"requiresTrigger": false`
   - For group chats: set `"requiresTrigger": true`

6. **If you changed the trigger word from Andy**, also update:
   - `groups/global/CLAUDE.md` — change "Andy" to your chosen name
   - `groups/main/CLAUDE.md` — same changes

## 7. Configure External Directory Access (Optional)

If you want the agent to access directories outside NanoClaw (e.g. git repos, project folders):

```bash
mkdir -p ~/.config/nanoclaw
```

Create `~/.config/nanoclaw/mount-allowlist.json`:

```json
{
  "allowedRoots": [
    {
      "path": "~/projects",
      "allowReadWrite": true,
      "description": "Development projects"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

- `allowReadWrite: true` = agents can modify files
- `allowReadWrite: false` = read-only access
- `nonMainReadOnly: true` = non-main groups are restricted to read-only even for read-write directories

If you don't need external access, create an empty allowlist:
```json
{
  "allowedRoots": [],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

To grant a specific group access to a directory, add to its config in `data/registered_groups.json`:
```json
"containerConfig": {
  "additionalMounts": [
    { "hostPath": "~/projects/my-app" }
  ]
}
```

## 8. Set Up the Background Service (launchd)

1. Build the project:
   ```bash
   npm run build
   mkdir -p logs
   ```

2. Create the launchd plist (run this as one command — it fills in your paths automatically):
   ```bash
   NODE_PATH=$(which node)
   PROJECT_PATH=$(pwd)
   HOME_PATH=$HOME

   cat > ~/Library/LaunchAgents/com.nanoclaw.plist << EOF
   <?xml version="1.0" encoding="UTF-8"?>
   <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
   <plist version="1.0">
   <dict>
       <key>Label</key>
       <string>com.nanoclaw</string>
       <key>ProgramArguments</key>
       <array>
           <string>${NODE_PATH}</string>
           <string>${PROJECT_PATH}/dist/index.js</string>
       </array>
       <key>WorkingDirectory</key>
       <string>${PROJECT_PATH}</string>
       <key>RunAtLoad</key>
       <true/>
       <key>KeepAlive</key>
       <true/>
       <key>EnvironmentVariables</key>
       <dict>
           <key>PATH</key>
           <string>/usr/local/bin:/usr/bin:/bin:${HOME_PATH}/.local/bin</string>
           <key>HOME</key>
           <string>${HOME_PATH}</string>
       </dict>
       <key>StandardOutPath</key>
       <string>${PROJECT_PATH}/logs/nanoclaw.log</string>
       <key>StandardErrorPath</key>
       <string>${PROJECT_PATH}/logs/nanoclaw.error.log</string>
   </dict>
   </plist>
   EOF
   ```

3. Load and start:
   ```bash
   launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
   ```

4. Verify:
   ```bash
   launchctl list | grep nanoclaw
   ```

## 9. Test It

Send a message in your registered WhatsApp chat:
- **Main channel:** Just type `hello`
- **Group chat:** Type `@Andy hello` (or your trigger word)

Watch the logs:
```bash
tail -f logs/nanoclaw.log
```

You should see the message being processed and a response sent back.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Service not starting | Check `logs/nanoclaw.error.log` |
| Container agent fails | Make sure container runtime is running: `container system start` or `docker info` |
| No response to messages | Check trigger word matches, verify JID in DB: `sqlite3 store/messages.db "SELECT * FROM registered_groups"` |
| WhatsApp disconnected | Run `npm run auth` to re-authenticate, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` |
| Unload service | `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` |
