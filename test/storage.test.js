import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { kv } = await import('../lib/kv-mock.js')
const {
  setLink, getLink, delLink, getAllLinks,
  saveUser, getUserCount, getAllUsers,
  addUserToLink, getLinkSubs,
  markInactive, reactivateUser
} = await import('../lib/storage.js')

describe('addUserToLink / getLinkSubs', () => {
  beforeEach(() => kv._clear())

  it('should add user to link subscription set', async () => {
    await addUserToLink('vip', 123)
    await addUserToLink('vip', 456)
    const subs = await getLinkSubs('vip')
    assert.deepEqual(subs.sort(), [123, 456])
  })

  it('should return empty array for nonexistent key', async () => {
    const subs = await getLinkSubs('nonexistent')
    assert.deepEqual(subs, [])
  })
})

describe('markInactive / reactivateUser', () => {
  beforeEach(() => kv._clear())

  it('should mark user as inactive', async () => {
    await saveUser({ user_id: 123, name: 'Test' })
    await markInactive(123)
    const user = await kv.get('user:123')
    assert.equal(user.inactive, true)
  })

  it('should reactivate user', async () => {
    await saveUser({ user_id: 123, name: 'Test' })
    await markInactive(123)
    await reactivateUser(123)
    const user = await kv.get('user:123')
    assert.equal(user.inactive, false)
  })
})

describe('saveUser with subscribed_key', () => {
  beforeEach(() => kv._clear())

  it('should save user with subscribed_key', async () => {
    await saveUser({ user_id: 123, name: 'Test', username: '@test' }, 'vip')
    const user = await kv.get('user:123')
    assert.equal(user.subscribed_key, 'vip')
    assert.equal(user.inactive, false)
  })

  it('should add user to link_subs set when subscribed_key provided', async () => {
    await saveUser({ user_id: 123, name: 'Test' }, 'vip')
    const subs = await getLinkSubs('vip')
    assert.ok(subs.includes(123))
  })
})
