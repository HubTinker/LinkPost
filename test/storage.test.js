import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { kv } = await import('../lib/kv-mock.js')
const {
  setLink, getLink, delLink, getAllLinks, getLinksByCreator,
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

describe('setLink with creator_id', () => {
  beforeEach(() => kv._clear())

  it('should store creator_id and add to user_links index', async () => {
    await setLink('vip', 'https://example.com', 'Welcome!', 123)
    const link = await kv.get('link:vip')
    assert.deepEqual(link, { url: 'https://example.com', message: 'Welcome!', creator_id: 123 })
    const userLinks = await kv.smembers('user_links:123')
    assert.ok(userLinks.includes('vip'))
  })

  it('should not create user_links index when creatorId is null', async () => {
    await setLink('vip', 'https://example.com', 'Welcome!', null)
    const link = await kv.get('link:vip')
    assert.equal(link.creator_id, null)
    const userLinks = await kv.smembers('user_links:null')
    assert.deepEqual(userLinks, [])
  })

  it('should not create user_links index when creatorId is undefined', async () => {
    await setLink('vip', 'https://example.com', 'Welcome!')
    const link = await kv.get('link:vip')
    assert.equal(link.creator_id, null)
  })
})

describe('getLinksByCreator', () => {
  beforeEach(() => kv._clear())

  it('should return only links for the given creator', async () => {
    await setLink('a', 'https://a.com', 'A', 123)
    await setLink('b', 'https://b.com', 'B', 456)
    await setLink('c', 'https://c.com', 'C', 123)
    const links123 = await getLinksByCreator(123)
    assert.equal(links123.length, 2)
    const keys = links123.map(l => l.key).sort()
    assert.deepEqual(keys, ['a', 'c'])
  })

  it('should return empty array when creator has no links', async () => {
    const links = await getLinksByCreator(999)
    assert.deepEqual(links, [])
  })
})

describe('delLink with creator index cleanup', () => {
  beforeEach(() => kv._clear())

  it('should remove key from user_links index on delete', async () => {
    await setLink('vip', 'https://example.com', 'Welcome!', 123)
    let userLinks = await kv.smembers('user_links:123')
    assert.ok(userLinks.includes('vip'))
    await delLink('vip')
    userLinks = await kv.smembers('user_links:123')
    assert.deepEqual(userLinks, [])
    const link = await kv.get('link:vip')
    assert.equal(link, null)
  })

  it('should not fail when deleting link without creator_id', async () => {
    await kv.set('link:nocreator', { url: 'https://x.com', message: 'X' })
    await kv.sadd('links_all', 'nocreator')
    await delLink('nocreator')
    const link = await kv.get('link:nocreator')
    assert.equal(link, null)
  })
})
