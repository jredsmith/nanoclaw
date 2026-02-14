import { PassThrough } from 'stream';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ---

const fakeStdin = { write: vi.fn() };
let fakeStdout: PassThrough;
let fakeStderr: PassThrough;
let fakeOnExit: ((code: number | null, signal: string | null) => void) | null;
let fakeOnError: ((err: Error) => void) | null;

function resetFakeProcess() {
  fakeStdout = new PassThrough();
  fakeStderr = new PassThrough();
  fakeOnExit = null;
  fakeOnError = null;
  fakeStdin.write.mockClear();
}

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    stdin: fakeStdin,
    stdout: fakeStdout,
    stderr: fakeStderr,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'exit') fakeOnExit = cb as typeof fakeOnExit;
      if (event === 'error') fakeOnError = cb as typeof fakeOnError;
    }),
    kill: vi.fn(),
  })),
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock('../config.js', () => ({
  SIGNAL_CLI_PATH: 'signal-cli',
  SIGNAL_PHONE_NUMBER: '+15551234567',
  SIGNAL_CONFIG_DIR: '/tmp/test-signal-auth',
  STORE_DIR: '/tmp/test-store',
}));

vi.mock('../db.js', () => ({
  getLastGroupSync: vi.fn(() => null),
  setLastGroupSync: vi.fn(),
  updateChatName: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import { SignalChannel, SignalChannelOpts } from './signal.js';
import { updateChatName, getLastGroupSync } from '../db.js';
import type { OnInboundMessage, OnChatMetadata } from '../types.js';

// --- Helpers ---

function createTestOpts(): SignalChannelOpts & {
  onMessage: ReturnType<typeof vi.fn<OnInboundMessage>>;
  onChatMetadata: ReturnType<typeof vi.fn<OnChatMetadata>>;
} {
  return {
    onMessage: vi.fn<OnInboundMessage>(),
    onChatMetadata: vi.fn<OnChatMetadata>(),
    registeredGroups: () => ({
      'signal-group:dGVzdA==': {
        name: 'Test Group',
        folder: 'test',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    }),
  };
}

/**
 * Send a JSON-RPC response to the daemon's stdout (simulating signal-cli output).
 */
function sendRpcResponse(id: number, result: unknown) {
  fakeStdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendRpcError(id: number, message: string) {
  fakeStdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, error: { message } }) + '\n',
  );
}

/**
 * Send a JSON-RPC notification (incoming message).
 */
function sendNotification(envelope: Record<string, unknown>) {
  fakeStdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: { envelope },
    }) + '\n',
  );
}

/**
 * Connect a channel by intercepting the readiness probe and responding.
 */
async function connectChannel(channel: SignalChannel): Promise<void> {
  const connectPromise = channel.connect();

  // Wait for the first RPC call (readiness probe: listGroups)
  await vi.waitFor(() => {
    expect(fakeStdin.write).toHaveBeenCalled();
  });

  // Respond to listGroups with empty array (readiness)
  const lastCall = fakeStdin.write.mock.calls[fakeStdin.write.mock.calls.length - 1][0];
  const rpc = JSON.parse(lastCall);
  sendRpcResponse(rpc.id, []);

  await connectPromise;
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

// --- Tests ---

describe('SignalChannel', () => {
  beforeEach(() => {
    resetFakeProcess();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Make syncGroupMetadata skip during connect() by providing a fresh cache.
    // Individual tests that need to test sync behaviour override this.
    vi.mocked(getLastGroupSync).mockReturnValue(new Date().toISOString());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('connection lifecycle', () => {
    it('connect() resolves after readiness probe succeeds', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);
      expect(channel.isConnected()).toBe(true);
    });

    it('disconnect sets connected to false and kills daemon', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('name is "signal"', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.name).toBe('signal');
    });

    it('prefixAssistantName is true', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.prefixAssistantName).toBe(true);
    });
  });

  describe('message handling', () => {
    it('delivers messages for registered groups', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendNotification({
        source: '+15559876543',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        dataMessage: {
          message: 'Hello world',
          groupInfo: { groupId: 'dGVzdA==' },
        },
      });
      await flush();

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      const msg = opts.onMessage.mock.calls[0][1];
      expect(msg.chat_jid).toBe('signal-group:dGVzdA==');
      expect(msg.sender).toBe('+15559876543');
      expect(msg.sender_name).toBe('Alice');
      expect(msg.content).toBe('Hello world');
    });

    it('fires onChatMetadata for all messages (including unregistered)', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendNotification({
        source: '+15559876543',
        sourceName: 'Bob',
        timestamp: 1700000000000,
        dataMessage: {
          message: 'Hi',
          groupInfo: { groupId: 'dW5yZWdpc3RlcmVk' },
        },
      });
      await flush();

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal-group:dW5yZWdpc3RlcmVk',
        expect.any(String),
      );
      // Not registered, so onMessage should NOT be called
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('ignores envelopes without dataMessage', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendNotification({
        source: '+15559876543',
        timestamp: 1700000000000,
        typingMessage: { action: 'STARTED' },
      });
      await flush();

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('ignores messages with empty content', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendNotification({
        source: '+15559876543',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        dataMessage: {
          message: '',
          groupInfo: { groupId: 'dGVzdA==' },
        },
      });
      await flush();

      // onChatMetadata still fires
      expect(opts.onChatMetadata).toHaveBeenCalled();
      // But onMessage does not for empty content
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('handles DM messages (no groupInfo)', async () => {
      const opts = createTestOpts();
      // Add DM JID to registered groups
      opts.registeredGroups = () => ({
        'signal:+15559876543': {
          name: 'Alice DM',
          folder: 'alice',
          trigger: '@Andy',
          added_at: '2024-01-01T00:00:00.000Z',
        },
      });
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendNotification({
        source: '+15559876543',
        sourceName: 'Alice',
        timestamp: 1700000000000,
        dataMessage: { message: 'DM hello' },
      });
      await flush();

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage.mock.calls[0][0]).toBe('signal:+15559876543');
    });

    it('falls back to source number when sourceName absent', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel(opts);
      await connectChannel(channel);

      sendNotification({
        source: '+15559876543',
        timestamp: 1700000000000,
        dataMessage: {
          message: 'No name',
          groupInfo: { groupId: 'dGVzdA==' },
        },
      });
      await flush();

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
      expect(opts.onMessage.mock.calls[0][1].sender_name).toBe('+15559876543');
    });
  });

  describe('outgoing message queue', () => {
    it('queues messages when disconnected', async () => {
      const channel = new SignalChannel(createTestOpts());
      // Don't connect — send while disconnected
      await channel.sendMessage('signal-group:dGVzdA==', 'Queued');
      expect(fakeStdin.write).not.toHaveBeenCalled();
    });

    it('sends via RPC when connected', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      fakeStdin.write.mockClear();
      const sendPromise = channel.sendMessage('signal-group:dGVzdA==', 'Hello');

      await vi.waitFor(() => {
        expect(fakeStdin.write).toHaveBeenCalled();
      });

      const rpc = JSON.parse(fakeStdin.write.mock.calls[0][0]);
      expect(rpc.method).toBe('send');
      expect(rpc.params.groupId).toBe('dGVzdA==');
      expect(rpc.params.message).toBe('Hello');

      sendRpcResponse(rpc.id, {});
      await sendPromise;
    });

    it('sends DM messages to recipient array', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      fakeStdin.write.mockClear();
      const sendPromise = channel.sendMessage('signal:+15559876543', 'DM');

      await vi.waitFor(() => {
        expect(fakeStdin.write).toHaveBeenCalled();
      });

      const rpc = JSON.parse(fakeStdin.write.mock.calls[0][0]);
      expect(rpc.method).toBe('send');
      expect(rpc.params.recipient).toEqual(['+15559876543']);

      sendRpcResponse(rpc.id, {});
      await sendPromise;
    });
  });

  describe('group metadata sync', () => {
    it('calls listGroups and updates chat names', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      fakeStdin.write.mockClear();
      const syncPromise = channel.syncGroupMetadata(true);

      await vi.waitFor(() => {
        expect(fakeStdin.write).toHaveBeenCalled();
      });

      const rpc = JSON.parse(fakeStdin.write.mock.calls[0][0]);
      expect(rpc.method).toBe('listGroups');

      sendRpcResponse(rpc.id, [
        { id: 'abc123', name: 'Group One' },
        { id: 'def456', name: 'Group Two' },
      ]);
      await syncPromise;

      expect(updateChatName).toHaveBeenCalledWith('signal-group:abc123', 'Group One');
      expect(updateChatName).toHaveBeenCalledWith('signal-group:def456', 'Group Two');
    });

    it('respects 24h cache when not forced', async () => {
      vi.mocked(getLastGroupSync).mockReturnValue(new Date().toISOString());
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      fakeStdin.write.mockClear();
      await channel.syncGroupMetadata(false);

      // Should not have made an RPC call (cached)
      expect(fakeStdin.write).not.toHaveBeenCalled();
    });

    it('syncs when cache is stale', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      // Set stale cache after connect so connect's internal sync was already skipped
      const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      vi.mocked(getLastGroupSync).mockReturnValue(staleDate);

      fakeStdin.write.mockClear();
      const syncPromise = channel.syncGroupMetadata(false);

      await vi.waitFor(() => {
        expect(fakeStdin.write).toHaveBeenCalled();
      });

      const rpc = JSON.parse(fakeStdin.write.mock.calls[0][0]);
      sendRpcResponse(rpc.id, []);
      await syncPromise;
    });
  });

  describe('JID ownership', () => {
    it('owns signal-group: JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('signal-group:abc123')).toBe(true);
    });

    it('owns signal: JIDs (DMs)', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('signal:+15551234567')).toBe(true);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('12345@s.whatsapp.net')).toBe(false);
    });

    it('does not own unknown JIDs', () => {
      const channel = new SignalChannel(createTestOpts());
      expect(channel.ownsJid('telegram:12345')).toBe(false);
    });
  });

  describe('typing indicators', () => {
    it('sends typing start for groups', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      fakeStdin.write.mockClear();
      const typingPromise = channel.setTyping('signal-group:dGVzdA==', true);

      await vi.waitFor(() => {
        expect(fakeStdin.write).toHaveBeenCalled();
      });

      const rpc = JSON.parse(fakeStdin.write.mock.calls[0][0]);
      expect(rpc.method).toBe('sendTyping');
      expect(rpc.params.groupId).toBe('dGVzdA==');
      expect(rpc.params.stop).toBe(false);

      sendRpcResponse(rpc.id, {});
      await typingPromise;
    });

    it('sends typing stop', async () => {
      const channel = new SignalChannel(createTestOpts());
      await connectChannel(channel);

      fakeStdin.write.mockClear();
      const typingPromise = channel.setTyping('signal-group:dGVzdA==', false);

      await vi.waitFor(() => {
        expect(fakeStdin.write).toHaveBeenCalled();
      });

      const rpc = JSON.parse(fakeStdin.write.mock.calls[0][0]);
      expect(rpc.params.stop).toBe(true);

      sendRpcResponse(rpc.id, {});
      await typingPromise;
    });

    it('does not throw on failure', async () => {
      const channel = new SignalChannel(createTestOpts());
      // Not connected — should not throw
      await expect(
        channel.setTyping('signal-group:dGVzdA==', true),
      ).resolves.toBeUndefined();
    });
  });
});
