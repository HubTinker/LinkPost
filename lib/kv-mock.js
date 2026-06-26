const store = new Map()
const sets = new Map()
const zsets = new Map()
const ttlStore = new Map()

function isExpired (key) {
  const expiresAt = ttlStore.get(key)
  if (expiresAt == null) return false
  if (Date.now() >= expiresAt) {
    ttlStore.delete(key)
    store.delete(key)
    return true
  }
  return false
}

function matchPattern (pattern, key) {
  if (pattern.endsWith('*')) {
    return key.startsWith(pattern.slice(0, -1))
  }
  return key === pattern
}

export const kv = {
  async get (key) {
    if (isExpired(key)) {
      console.log('[KV-MOCK] get', key, '\u2192 expired')
      return null
    }
    const result = store.has(key) ? store.get(key) : null
    console.log('[KV-MOCK] get', key, '\u2192', result ? 'found' : 'miss')
    return result
  },

  async set (key, value) {
    store.set(key, value)
    console.log('[KV-MOCK] set', key)
  },

  async del (key) {
    store.delete(key)
    console.log('[KV-MOCK] del', key)
  },

  async keys (pattern) {
    const matched = []
    for (const key of store.keys()) {
      if (matchPattern(pattern, key)) {
        matched.push(key)
      }
    }
    console.log('[KV-MOCK] keys', pattern, '\u2192', matched.length)
    return matched
  },

  async sadd (setName, member) {
    if (!sets.has(setName)) {
      sets.set(setName, new Set())
    }
    const existed = sets.get(setName).has(member)
    sets.get(setName).add(member)
    console.log('[KV-MOCK] sadd', setName, member, '\u2192', existed ? 'already exists' : 'added')
    return existed ? 0 : 1
  },

  async smembers (setName) {
    const result = sets.has(setName) ? [...sets.get(setName)] : []
    console.log('[KV-MOCK] smembers', setName, '\u2192', result.length)
    return result
  },

  async srem (setName, member) {
    if (sets.has(setName)) {
      sets.get(setName).delete(member)
    }
    console.log('[KV-MOCK] srem', setName, member)
  },

  async scard (setName) {
    const count = sets.has(setName) ? sets.get(setName).size : 0
    console.log('[KV-MOCK] scard', setName, '\u2192', count)
    return count
  },

  async sismember (setName, member) {
    const exists = sets.has(setName) && sets.get(setName).has(member)
    console.log('[KV-MOCK] sismember', setName, member, '\u2192', exists ? 1 : 0)
    return exists ? 1 : 0
  },

  async zadd (zsetName, { score, member }) {
    if (!zsets.has(zsetName)) {
      zsets.set(zsetName, new Map())
    }
    zsets.get(zsetName).set(member, score)
    console.log('[KV-MOCK] zadd', zsetName, member, score)
  },

  async zrem (zsetName, member) {
    if (zsets.has(zsetName)) {
      zsets.get(zsetName).delete(member)
    }
    console.log('[KV-MOCK] zrem', zsetName, member)
  },

  async zrangebyscore (zsetName, min, max) {
    if (!zsets.has(zsetName)) {
      console.log('[KV-MOCK] zrangebyscore', zsetName, min, max, '\u2192 0')
      return []
    }
    const result = []
    for (const [member, score] of zsets.get(zsetName)) {
      if (score >= min && score <= max) {
        result.push(member)
      }
    }
    console.log('[KV-MOCK] zrangebyscore', zsetName, min, max, '\u2192', result.length)
    return result
  },

  async incr (key) {
    if (isExpired(key)) {
      console.log('[KV-MOCK] incr', key, '\u2192 expired, restarting at 1')
    }
    const current = store.has(key) ? Number(store.get(key)) : 0
    const next = current + 1
    store.set(key, next)
    console.log('[KV-MOCK] incr', key, '\u2192', next)
    return next
  },

  async pexpire (key, ms) {
    ttlStore.set(key, Date.now() + ms)
    console.log('[KV-MOCK] pexpire', key, ms + 'ms')
  },

  async expire (key, seconds) {
    ttlStore.set(key, Date.now() + seconds * 1000)
    console.log('[KV-MOCK] expire', key, seconds + 's')
  },

  _clear () {
    store.clear()
    sets.clear()
    zsets.clear()
    ttlStore.clear()
    console.log('[KV-MOCK] _clear \u2014 all data wiped')
  }
}
