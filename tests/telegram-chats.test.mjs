import assert from 'node:assert/strict';
import test from 'node:test';
import { testIntegration } from '../wizard/lib/integrations.mjs';

test('telegram probe discovers chats through getUpdates when chatId is absent', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/getMe')) {
      return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 });
    }
    if (String(url).includes('/getUpdates')) {
      return new Response(JSON.stringify({
        ok: true,
        result: [
          { message: { chat: { id: -1001, title: 'Sales', type: 'supergroup' } } },
          { message: { chat: { id: -1001, title: 'Sales', type: 'supergroup' } } },
          { message: { chat: { id: 42, first_name: 'Ada', last_name: 'Lovelace', type: 'private' } } },
        ],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: false, description: 'unexpected' }), { status: 500 });
  };
  try {
    const result = await testIntegration('telegram', { token: '123:test-token' });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'connected');
    assert.deepEqual(result.details.chats, [
      { id: '-1001', title: 'Sales', type: 'supergroup' },
      { id: '42', title: 'Ada Lovelace', type: 'private' },
    ]);
    assert.equal(calls.some((url) => url.includes('/getUpdates')), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('telegram probe keeps a safe manual fallback when getUpdates is empty', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/getMe')) {
      return new Response(JSON.stringify({ ok: true, result: { username: 'test_bot' } }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: [] }), { status: 200 });
  };
  try {
    const result = await testIntegration('telegram', { token: '123:test-token' });
    assert.equal(result.ok, true);
    assert.equal(result.details.needsChatId, true);
    assert.deepEqual(result.details.chats, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
