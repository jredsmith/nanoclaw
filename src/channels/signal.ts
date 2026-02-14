import { ChildProcess, spawn } from 'child_process';
import { createInterface, Interface as ReadlineInterface } from 'readline';

import {
  SIGNAL_CLI_PATH,
  SIGNAL_CONFIG_DIR,
  SIGNAL_PHONE_NUMBER,
  STORE_DIR,
} from '../config.js';
import {
  getLastGroupSync,
  setLastGroupSync,
  updateChatName,
} from '../db.js';
import { logger } from '../logger.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RPC_TIMEOUT_MS = 30_000;
const READINESS_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 5000;
const MAX_MESSAGE_LENGTH = 5900;

export interface SignalChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SignalChannel implements Channel {
  name = 'signal';
  prefixAssistantName = true;

  private daemon: ChildProcess | null = null;
  private rl: ReadlineInterface | null = null;
  private connected = false;
  private intentionalDisconnect = false;
  private outgoingQueue: Array<{ jid: string; text: string }> = [];
  private flushing = false;
  private groupSyncTimerStarted = false;
  private rpcIdCounter = 0;
  private pendingRpc = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  private opts: SignalChannelOpts;

  constructor(opts: SignalChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (!SIGNAL_PHONE_NUMBER) {
      throw new Error(
        'SIGNAL_PHONE_NUMBER environment variable is required. ' +
          'Set it to the phone number registered with signal-cli (e.g. +14155551234).',
      );
    }

    this.intentionalDisconnect = false;

    return new Promise<void>((resolve, reject) => {
      this.daemon = spawn(
        SIGNAL_CLI_PATH,
        [
          '--config',
          SIGNAL_CONFIG_DIR,
          '-a',
          SIGNAL_PHONE_NUMBER,
          'daemon',
          '--json',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );

      this.daemon.on('error', (err) => {
        logger.error({ err }, 'signal-cli daemon failed to start');
        if (!this.connected) {
          reject(
            new Error(
              `signal-cli failed to start: ${err.message}. ` +
                `Install signal-cli (brew install signal-cli) and run: npx tsx src/signal-auth.ts register`,
            ),
          );
        }
      });

      this.daemon.on('exit', (code, signal) => {
        logger.info({ code, signal }, 'signal-cli daemon exited');
        this.connected = false;
        this.rejectAllPendingRpc('signal-cli daemon exited');

        if (!this.intentionalDisconnect && code !== 0) {
          setTimeout(() => this.reconnect(), RECONNECT_DELAY_MS);
        }
      });

      // Log stderr
      if (this.daemon.stderr) {
        const stderrRl = createInterface({ input: this.daemon.stderr });
        stderrRl.on('line', (line) => {
          logger.debug({ signalStderr: line }, 'signal-cli');
        });
      }

      // Parse stdout for JSON-RPC
      if (this.daemon.stdout) {
        this.rl = createInterface({ input: this.daemon.stdout });
        this.rl.on('line', (line) => this.handleLine(line));
      }

      // Readiness probe: try listGroups until it succeeds or timeout
      const startTime = Date.now();
      const probe = () => {
        if (this.connected) return; // Already resolved

        this.rpcCall('listGroups', {})
          .then(async () => {
            if (this.connected) return;
            this.connected = true;
            logger.info('Connected to Signal');

            await this.syncGroupMetadata();
            if (!this.groupSyncTimerStarted) {
              this.groupSyncTimerStarted = true;
              setInterval(() => {
                this.syncGroupMetadata().catch((err) =>
                  logger.error({ err }, 'Periodic group sync failed'),
                );
              }, GROUP_SYNC_INTERVAL_MS);
            }

            this.flushOutgoingQueue().catch((err) =>
              logger.error({ err }, 'Failed to flush outgoing queue'),
            );

            resolve();
          })
          .catch(() => {
            if (Date.now() - startTime > READINESS_TIMEOUT_MS) {
              reject(
                new Error(
                  `signal-cli daemon did not become ready within ${READINESS_TIMEOUT_MS}ms. ` +
                    `Check that ${SIGNAL_PHONE_NUMBER} is registered: npx tsx src/signal-auth.ts register`,
                ),
              );
              return;
            }
            setTimeout(probe, 1000);
          });
      };
      // Give daemon a moment to start before first probe
      setTimeout(probe, 500);
    });
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal-group:') || jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    this.connected = false;
    this.rejectAllPendingRpc('disconnecting');
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.daemon) {
      this.daemon.kill('SIGTERM');
      this.daemon = null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Split long messages for Signal's ~6000 char limit
    if (text.length > MAX_MESSAGE_LENGTH) {
      const chunks = splitMessage(text, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        await this.sendMessage(jid, chunk);
      }
      return;
    }

    if (!this.connected || !this.daemon?.stdin) {
      this.outgoingQueue.push({ jid, text });
      logger.info(
        { jid, length: text.length, queueSize: this.outgoingQueue.length },
        'Signal disconnected, message queued',
      );
      return;
    }

    try {
      if (jid.startsWith('signal-group:')) {
        const groupId = jid.slice('signal-group:'.length);
        await this.rpcCall('send', {
          groupId,
          message: text,
        });
      } else if (jid.startsWith('signal:')) {
        const recipient = jid.slice('signal:'.length);
        await this.rpcCall('send', {
          recipient: [recipient],
          message: text,
        });
      } else {
        logger.warn({ jid }, 'Unknown JID format, cannot send');
        return;
      }
      logger.info({ jid, length: text.length }, 'Message sent');
    } catch (err) {
      this.outgoingQueue.push({ jid, text });
      logger.warn(
        { jid, err, queueSize: this.outgoingQueue.length },
        'Failed to send, message queued',
      );
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.connected) return;
    try {
      if (jid.startsWith('signal-group:')) {
        const groupId = jid.slice('signal-group:'.length);
        await this.rpcCall('sendTyping', {
          groupId,
          stop: !isTyping,
        });
      } else if (jid.startsWith('signal:')) {
        const recipient = jid.slice('signal:'.length);
        await this.rpcCall('sendTyping', {
          recipient: [recipient],
          stop: !isTyping,
        });
      }
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to update typing status');
    }
  }

  async syncGroupMetadata(force = false): Promise<void> {
    if (!force) {
      const lastSync = getLastGroupSync();
      if (lastSync) {
        const lastSyncTime = new Date(lastSync).getTime();
        if (Date.now() - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
          logger.debug({ lastSync }, 'Skipping group sync - synced recently');
          return;
        }
      }
    }

    try {
      logger.info('Syncing group metadata from Signal...');
      const result = (await this.rpcCall('listGroups', {})) as
        | Array<{ id: string; name: string }>
        | undefined;

      let count = 0;
      for (const group of result || []) {
        if (group.name && group.id) {
          const jid = `signal-group:${group.id}`;
          updateChatName(jid, group.name);
          count++;
        }
      }

      setLastGroupSync();
      logger.info({ count }, 'Group metadata synced');
    } catch (err) {
      logger.error({ err }, 'Failed to sync group metadata');
    }
  }

  // --- Private methods ---

  private handleLine(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      logger.debug(
        { line: line.slice(0, 200) },
        'Non-JSON line from signal-cli',
      );
      return;
    }

    // Handle RPC responses (from our outbound requests)
    const id = parsed.id as number | undefined;
    if (id !== undefined && this.pendingRpc.has(id)) {
      const pending = this.pendingRpc.get(id)!;
      this.pendingRpc.delete(id);
      clearTimeout(pending.timer);
      if (parsed.error) {
        const errObj = parsed.error as { message?: string };
        pending.reject(
          new Error(errObj.message || JSON.stringify(parsed.error)),
        );
      } else {
        pending.resolve(parsed.result);
      }
      return;
    }

    // Handle incoming message notifications
    if (parsed.method === 'receive') {
      const params = parsed.params as { envelope?: Record<string, unknown> } | undefined;
      if (params?.envelope) {
        this.handleEnvelope(params.envelope);
      }
    }
  }

  private handleEnvelope(envelope: Record<string, unknown>): void {
    const dataMessage = envelope.dataMessage as Record<string, unknown> | undefined;
    if (!dataMessage) return; // Ignore typing indicators, receipts, etc.

    const source = envelope.source as string; // phone number
    const sourceName = (envelope.sourceName as string) || source;
    const timestamp = new Date(envelope.timestamp as number).toISOString();

    const groupInfo = dataMessage.groupInfo as { groupId?: string } | undefined;
    let chatJid: string;
    if (groupInfo?.groupId) {
      chatJid = `signal-group:${groupInfo.groupId}`;
    } else {
      chatJid = `signal:${source}`;
    }

    // Always notify about metadata (enables group discovery)
    this.opts.onChatMetadata(chatJid, timestamp);

    // Only deliver full messages for registered groups
    const groups = this.opts.registeredGroups();
    if (groups[chatJid]) {
      const content = (dataMessage.message as string) || '';
      if (!content) return;

      const messageId = `${envelope.timestamp}-${source}`;

      this.opts.onMessage(chatJid, {
        id: messageId,
        chat_jid: chatJid,
        sender: source,
        sender_name: sourceName,
        content,
        timestamp,
        is_from_me: source === SIGNAL_PHONE_NUMBER,
      });
    }
  }

  private rpcCall(
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.daemon?.stdin) {
        reject(new Error('signal-cli daemon not running'));
        return;
      }

      const id = ++this.rpcIdCounter;
      const request =
        JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

      const timer = setTimeout(() => {
        if (this.pendingRpc.has(id)) {
          this.pendingRpc.delete(id);
          reject(new Error(`RPC timeout for ${method}`));
        }
      }, RPC_TIMEOUT_MS);

      this.pendingRpc.set(id, { resolve, reject, timer });
      this.daemon.stdin.write(request);
    });
  }

  private rejectAllPendingRpc(reason: string): void {
    for (const [id, pending] of this.pendingRpc) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`RPC cancelled: ${reason}`));
    }
    this.pendingRpc.clear();
  }

  private async reconnect(): Promise<void> {
    if (this.intentionalDisconnect) return;
    logger.info('Reconnecting signal-cli daemon...');
    try {
      await this.connect();
    } catch (err) {
      logger.error({ err }, 'Failed to reconnect, retrying in 10s');
      setTimeout(() => this.reconnect(), 10000);
    }
  }

  private async flushOutgoingQueue(): Promise<void> {
    if (this.flushing || this.outgoingQueue.length === 0) return;
    this.flushing = true;
    try {
      logger.info(
        { count: this.outgoingQueue.length },
        'Flushing outgoing message queue',
      );
      while (this.outgoingQueue.length > 0) {
        const item = this.outgoingQueue.shift()!;
        await this.sendMessage(item.jid, item.text);
      }
    } finally {
      this.flushing = false;
    }
  }
}

/**
 * Split a long message into chunks that fit Signal's message length limit.
 * Splits on paragraph boundaries first, then sentence boundaries, then hard limit.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitAt = -1;

    // Try splitting on paragraph boundary
    const lastParagraph = remaining.lastIndexOf('\n\n', maxLen);
    if (lastParagraph > maxLen * 0.3) {
      splitAt = lastParagraph + 2;
    }

    // Try splitting on newline
    if (splitAt === -1) {
      const lastNewline = remaining.lastIndexOf('\n', maxLen);
      if (lastNewline > maxLen * 0.3) {
        splitAt = lastNewline + 1;
      }
    }

    // Try splitting on sentence boundary
    if (splitAt === -1) {
      const lastSentence = remaining.lastIndexOf('. ', maxLen);
      if (lastSentence > maxLen * 0.3) {
        splitAt = lastSentence + 2;
      }
    }

    // Hard split at max length
    if (splitAt === -1) {
      splitAt = maxLen;
    }

    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
