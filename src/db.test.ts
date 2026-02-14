import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  createTask,
  deleteTask,
  getAllChats,
  getMessagesSince,
  getNewMessages,
  getTaskById,
  storeChatMetadata,
  storeMessage,
  updateTask,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

// Helper to store a message using the normalized NewMessage interface
function store(overrides: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
}) {
  storeMessage({
    id: overrides.id,
    chat_jid: overrides.chat_jid,
    sender: overrides.sender,
    sender_name: overrides.sender_name,
    content: overrides.content,
    timestamp: overrides.timestamp,
    is_from_me: overrides.is_from_me ?? false,
  });
}

// --- storeMessage (NewMessage format) ---

describe('storeMessage', () => {
  it('stores a message and retrieves it', () => {
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-1',
      chat_jid: 'signal-group:testgrp',
      sender: '+15551230000',
      sender_name: 'Alice',
      content: 'hello world',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('signal-group:testgrp', '2024-01-01T00:00:00.000Z', 'BotName');
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('msg-1');
    expect(messages[0].sender).toBe('+15551230000');
    expect(messages[0].sender_name).toBe('Alice');
    expect(messages[0].content).toBe('hello world');
  });

  it('stores empty content', () => {
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-2',
      chat_jid: 'signal-group:testgrp',
      sender: '+15551110000',
      sender_name: 'Dave',
      content: '',
      timestamp: '2024-01-01T00:00:04.000Z',
    });

    const messages = getMessagesSince('signal-group:testgrp', '2024-01-01T00:00:00.000Z', 'BotName');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('');
  });

  it('stores is_from_me flag', () => {
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-3',
      chat_jid: 'signal-group:testgrp',
      sender: '+15550000000',
      sender_name: 'Me',
      content: 'my message',
      timestamp: '2024-01-01T00:00:05.000Z',
      is_from_me: true,
    });

    // Message is stored (we can retrieve it — is_from_me doesn't affect retrieval)
    const messages = getMessagesSince('signal-group:testgrp', '2024-01-01T00:00:00.000Z', 'BotName');
    expect(messages).toHaveLength(1);
  });

  it('upserts on duplicate id+chat_jid', () => {
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:00.000Z');

    store({
      id: 'msg-dup',
      chat_jid: 'signal-group:testgrp',
      sender: '+15551230000',
      sender_name: 'Alice',
      content: 'original',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    store({
      id: 'msg-dup',
      chat_jid: 'signal-group:testgrp',
      sender: '+15551230000',
      sender_name: 'Alice',
      content: 'updated',
      timestamp: '2024-01-01T00:00:01.000Z',
    });

    const messages = getMessagesSince('signal-group:testgrp', '2024-01-01T00:00:00.000Z', 'BotName');
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('updated');
  });
});

// --- getMessagesSince ---

describe('getMessagesSince', () => {
  beforeEach(() => {
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:00.000Z');

    const msgs = [
      { id: 'm1', content: 'first', ts: '2024-01-01T00:00:01.000Z', name: 'Alice', phone: '+15551000001' },
      { id: 'm2', content: 'second', ts: '2024-01-01T00:00:02.000Z', name: 'Bob', phone: '+15551000002' },
      { id: 'm3', content: 'Andy: bot reply', ts: '2024-01-01T00:00:03.000Z', name: 'Bot', phone: '+15551000003' },
      { id: 'm4', content: 'third', ts: '2024-01-01T00:00:04.000Z', name: 'Carol', phone: '+15551000004' },
    ];
    for (const m of msgs) {
      store({
        id: m.id,
        chat_jid: 'signal-group:testgrp',
        sender: m.phone,
        sender_name: m.name,
        content: m.content,
        timestamp: m.ts,
      });
    }
  });

  it('returns messages after the given timestamp', () => {
    const msgs = getMessagesSince('signal-group:testgrp', '2024-01-01T00:00:02.000Z', 'Andy');
    // Should exclude m1, m2 (before/at timestamp), m3 (bot message)
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe('third');
  });

  it('excludes messages from the assistant (content prefix)', () => {
    const msgs = getMessagesSince('signal-group:testgrp', '2024-01-01T00:00:00.000Z', 'Andy');
    const botMsgs = msgs.filter((m) => m.content.startsWith('Andy:'));
    expect(botMsgs).toHaveLength(0);
  });

  it('returns all messages when sinceTimestamp is empty', () => {
    const msgs = getMessagesSince('signal-group:testgrp', '', 'Andy');
    // 3 user messages (bot message excluded)
    expect(msgs).toHaveLength(3);
  });
});

// --- getNewMessages ---

describe('getNewMessages', () => {
  beforeEach(() => {
    storeChatMetadata('signal-group:group1', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('signal-group:group2', '2024-01-01T00:00:00.000Z');

    const msgs = [
      { id: 'a1', chat: 'signal-group:group1', content: 'g1 msg1', ts: '2024-01-01T00:00:01.000Z' },
      { id: 'a2', chat: 'signal-group:group2', content: 'g2 msg1', ts: '2024-01-01T00:00:02.000Z' },
      { id: 'a3', chat: 'signal-group:group1', content: 'Andy: reply', ts: '2024-01-01T00:00:03.000Z' },
      { id: 'a4', chat: 'signal-group:group1', content: 'g1 msg2', ts: '2024-01-01T00:00:04.000Z' },
    ];
    for (const m of msgs) {
      store({
        id: m.id,
        chat_jid: m.chat,
        sender: '+15559876543',
        sender_name: 'User',
        content: m.content,
        timestamp: m.ts,
      });
    }
  });

  it('returns new messages across multiple groups', () => {
    const { messages, newTimestamp } = getNewMessages(
      ['signal-group:group1', 'signal-group:group2'],
      '2024-01-01T00:00:00.000Z',
      'Andy',
    );
    // Excludes 'Andy: reply', returns 3 messages
    expect(messages).toHaveLength(3);
    expect(newTimestamp).toBe('2024-01-01T00:00:04.000Z');
  });

  it('filters by timestamp', () => {
    const { messages } = getNewMessages(
      ['signal-group:group1', 'signal-group:group2'],
      '2024-01-01T00:00:02.000Z',
      'Andy',
    );
    // Only g1 msg2 (after ts, not bot)
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('g1 msg2');
  });

  it('returns empty for no registered groups', () => {
    const { messages, newTimestamp } = getNewMessages([], '', 'Andy');
    expect(messages).toHaveLength(0);
    expect(newTimestamp).toBe('');
  });
});

// --- storeChatMetadata ---

describe('storeChatMetadata', () => {
  it('stores chat with JID as default name', () => {
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:00.000Z');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].jid).toBe('signal-group:testgrp');
    expect(chats[0].name).toBe('signal-group:testgrp');
  });

  it('stores chat with explicit name', () => {
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:00.000Z', 'My Group');
    const chats = getAllChats();
    expect(chats[0].name).toBe('My Group');
  });

  it('updates name on subsequent call with name', () => {
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:00.000Z');
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:01.000Z', 'Updated Name');
    const chats = getAllChats();
    expect(chats).toHaveLength(1);
    expect(chats[0].name).toBe('Updated Name');
  });

  it('preserves newer timestamp on conflict', () => {
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:05.000Z');
    storeChatMetadata('signal-group:testgrp', '2024-01-01T00:00:01.000Z');
    const chats = getAllChats();
    expect(chats[0].last_message_time).toBe('2024-01-01T00:00:05.000Z');
  });
});

// --- Task CRUD ---

describe('task CRUD', () => {
  it('creates and retrieves a task', () => {
    createTask({
      id: 'task-1',
      group_folder: 'main',
      chat_jid: 'signal-group:testgrp',
      prompt: 'do something',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: '2024-06-01T00:00:00.000Z',
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    const task = getTaskById('task-1');
    expect(task).toBeDefined();
    expect(task!.prompt).toBe('do something');
    expect(task!.status).toBe('active');
  });

  it('updates task status', () => {
    createTask({
      id: 'task-2',
      group_folder: 'main',
      chat_jid: 'signal-group:testgrp',
      prompt: 'test',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    updateTask('task-2', { status: 'paused' });
    expect(getTaskById('task-2')!.status).toBe('paused');
  });

  it('deletes a task and its run logs', () => {
    createTask({
      id: 'task-3',
      group_folder: 'main',
      chat_jid: 'signal-group:testgrp',
      prompt: 'delete me',
      schedule_type: 'once',
      schedule_value: '2024-06-01T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: null,
      status: 'active',
      created_at: '2024-01-01T00:00:00.000Z',
    });

    deleteTask('task-3');
    expect(getTaskById('task-3')).toBeUndefined();
  });
});
