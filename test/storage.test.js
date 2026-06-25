import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const { kv } = await import('../lib/kv-mock.js')
const {
  setLink, getLink, delLink, getAllLinks, getLinksByCreator,
  saveUser, getUserCount, getAllUsers,
  addUserToLink, getLinkSubs,
  markInactive, reactivateUser,
  getLinkAge, getLinkSubCount, getLinkCount,
  getDailyStat, getDailyTotal, getStatRange, getTotalRange,
  daysAgo
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
    assert.equal(link.url, 'https://example.com')
    assert.equal(link.message, 'Welcome!')
    assert.equal(link.creator_id, 123)
    assert.ok(typeof link.created_at === 'number')
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

describe('setLink created_at', () => {
  beforeEach(() => kv._clear())

  it('should store created_at on new link', async () => {
    await setLink('vip', 'https://x.com', 'Hi!', 123)
    const link = await kv.get('link:vip')
    assert.ok(typeof link.created_at === 'number', 'created_at should be a number')
    assert.ok(link.created_at > 0, 'created_at should be positive timestamp')
  })
})

describe('getLinkAge', () => {
  beforeEach(() => kv._clear())

  it('should return 0 days for just-created link', async () => {
    await setLink('vip', 'https://x.com', 'Hi!', 123)
    const age = await getLinkAge('vip')
    assert.equal(age, 0)
  })

  it('should return null for link without created_at', async () => {
    await kv.set('link:old', { url: 'https://x.com', message: 'X' })
    const age = await getLinkAge('old')
    assert.equal(age, null)
  })
})

describe('saveUser first_seen', () => {
  beforeEach(() => kv._clear())

  it('should set first_seen for new user', async () => {
    await saveUser({ user_id: 100, name: 'New' })
    const user = await kv.get('user:100')
    assert.ok(typeof user.first_seen === 'number')
    assert.ok(user.first_seen > 0)
  })

  it('should NOT overwrite first_seen for existing user', async () => {
    await saveUser({ user_id: 100, name: 'Old' })
    const user1 = await kv.get('user:100')
    const originalFirstSeen = user1.first_seen
    // Small delay to ensure different timestamp
    await new Promise(r => setTimeout(r, 5))
    await saveUser({ user_id: 100, name: 'Updated' })
    const user2 = await kv.get('user:100')
    assert.equal(user2.first_seen, originalFirstSeen)
  })

  it('should incr stats:new:total for new user', async () => {
    await saveUser({ user_id: 100, name: 'New' })
    const today = daysAgo(0)
    const count = await getDailyTotal(today)
    assert.ok(count >= 1, 'should increment total daily counter')
  })

  it('should NOT incr stats:new:total for existing user', async () => {
    await saveUser({ user_id: 100, name: 'Old' })
    const today = daysAgo(0)
    const count1 = await getDailyTotal(today)
    await saveUser({ user_id: 100, name: 'Updated' })
    const count2 = await getDailyTotal(today)
    assert.equal(count2, count1)
  })

  it('should set first_seen for existing user without it (migration)', async () => {
    await kv.set('user:100', { user_id: 100, name: 'Legacy', inactive: false, updated_at: 1000000 })
    await kv.sadd('users_all', '100')
    await saveUser({ user_id: 100, name: 'LegacyUpdated' })
    const user = await kv.get('user:100')
    assert.ok(typeof user.first_seen === 'number')
    const today = daysAgo(0)
    const count = await getDailyTotal(today)
    assert.equal(count, 0, 'should NOT increment counter for migrated user')
  })
})

describe('addUserToLink returns value and stats', () => {
  beforeEach(() => kv._clear())

  it('should return 1 for new subscriber', async () => {
    const added = await addUserToLink('vip', 100)
    assert.equal(added, 1)
  })

  it('should return 0 for already subscribed user', async () => {
    await addUserToLink('vip', 100)
    const added = await addUserToLink('vip', 100)
    assert.equal(added, 0)
  })

  it('should incr daily stat for new subscriber', async () => {
    await addUserToLink('vip', 100)
    const today = daysAgo(0)
    const count = await getDailyStat('vip', today)
    assert.ok(count >= 1)
  })

  it('should NOT incr daily stat for already subscribed user', async () => {
    await addUserToLink('vip', 100)
    const today = daysAgo(0)
    const count1 = await getDailyStat('vip', today)
    await addUserToLink('vip', 100)
    const count2 = await getDailyStat('vip', today)
    assert.equal(count2, count1)
  })
})

describe('getDailyStat / getDailyTotal', () => {
  beforeEach(() => kv._clear())

  it('should return 0 for non-existent date', async () => {
    const val = await getDailyStat('vip', '2020-01-01')
    assert.equal(val, 0)
  })

  it('should return 0 for non-existent total date', async () => {
    const val = await getDailyTotal('2020-01-01')
    assert.equal(val, 0)
  })

  it('should read back incr value', async () => {
    await kv.incr('stats:new:vip:2026-06-25')
    await kv.incr('stats:new:vip:2026-06-25')
    const val = await getDailyStat('vip', '2026-06-25')
    assert.equal(val, 2)
  })
})

describe('getStatRange / getTotalRange', () => {
  beforeEach(() => kv._clear())

  it('should return correct range with zeros for missing dates', async () => {
    await kv.incr('stats:new:mykey:2026-06-23')
    await kv.incr('stats:new:mykey:2026-06-25')
    await kv.incr('stats:new:mykey:2026-06-25')
    const range = await getStatRange('mykey', '2026-06-23', '2026-06-25')
    assert.equal(range.length, 3)
    assert.deepEqual(range[0], { date: '2026-06-23', count: 1 })
    assert.deepEqual(range[1], { date: '2026-06-24', count: 0 })
    assert.deepEqual(range[2], { date: '2026-06-25', count: 2 })
  })
})

describe('getLinkSubCount', () => {
  beforeEach(() => kv._clear())

  it('should return set size', async () => {
    await kv.sadd('link_subs:vip', '100')
    await kv.sadd('link_subs:vip', '200')
    const count = await getLinkSubCount('vip')
    assert.equal(count, 2)
  })

  it('should return 0 for empty set', async () => {
    const count = await getLinkSubCount('nonexistent')
    assert.equal(count, 0)
  })
})

describe('getLinkCount', () => {
  beforeEach(() => kv._clear())

  it('should return link count via SCARD', async () => {
    await kv.sadd('links_all', 'a')
    await kv.sadd('links_all', 'b')
    await kv.sadd('links_all', 'c')
    const count = await getLinkCount()
    assert.equal(count, 3)
  })

  it('should return 0 for empty set', async () => {
    const count = await getLinkCount()
    assert.equal(count, 0)
  })
})
