import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { kv } from '../lib/kv-mock.js'
import { setNavMessageId, getNavMessageId } from '../lib/nav.js'

describe('nav message tracking', () => {
  beforeEach(async () => {
    await kv._clear()
  })

  it('should return null when nothing stored', async () => {
    assert.strictEqual(await getNavMessageId(1), null)
  })

  it('should roundtrip message id per chat', async () => {
    await setNavMessageId(1, 42)
    await setNavMessageId(2, 43)
    assert.strictEqual(await getNavMessageId(1), 42)
    assert.strictEqual(await getNavMessageId(2), 43)
  })

  it('should store under nav_msg:{chatId} prefix', async () => {
    await setNavMessageId(1, 42)
    assert.strictEqual(await kv.get('nav_msg:1'), 42)
  })

  it('should overwrite previous value', async () => {
    await setNavMessageId(1, 42)
    await setNavMessageId(1, 43)
    assert.strictEqual(await getNavMessageId(1), 43)
  })
})
