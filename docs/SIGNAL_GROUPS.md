# Signal Group Management

## Known Limitation

signal-cli 0.13.24 cannot accept pending group invitations for Signal v2 groups. When a user creates a group and adds Jarvis, Jarvis becomes a `pendingMember` but cannot promote itself to a full member. The `updateGroup` command fails with `NotAbleToApplyGroupV2ChangeException`.

Ref: https://github.com/AsamK/signal-cli/issues/480

## Creating New Groups

### Option A: Jarvis Creates the Group (Recommended)

Tell Jarvis in the main channel (Alpha) to create a group:

> "Create a new group called 'Project X' and invite +number"

Under the hood, this uses signal-cli's `updateGroup`:

```bash
echo '{"jsonrpc":"2.0","method":"updateGroup","params":{"name":"Project X","members":["+number"]},"id":1}' | nc localhost 7583
```

Jarvis is automatically a full member since he created the group. After creation, register it via the main channel.

### Option B: Join via Invite Link

1. Create the group on your phone
2. Go to group settings > "Group link" > enable it
3. Share the link with Jarvis

```bash
echo '{"jsonrpc":"2.0","method":"joinGroup","params":{"uri":"https://signal.group/#..."},"id":1}' | nc localhost 7583
```

## Registering a Group

After Jarvis is a member, the group must be registered before messages are processed. Tell Jarvis in Alpha:

> "Register the new group called 'Project X'"

Jarvis will query available groups, find the JID, and register it via IPC.

## Useful Commands

```bash
# List all groups
echo '{"jsonrpc":"2.0","method":"listGroups","id":1}' | nc localhost 7583

# Check registered groups
sqlite3 store/messages.db "SELECT jid, name, folder FROM registered_groups"

# Check all known chats
sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE 'signal-group:%'"
```
