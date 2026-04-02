/**
 * KEYS[1] = task:{taskId}:meta (hash)
 *
 * ARGV[1] = expected current status (e.g. "GENERATING")
 *
 * ARGV[2] = next status (e.g. "DONE")
 */
export const SET_STATUS_LUA_SCRIPT = `
local cur = redis.call("HGET", KEYS[1], "status")
if cur == ARGV[1] then
  redis.call("HSET", KEYS[1], "status", ARGV[2])
  return 1
end
return 0
`;

/**
 * KEYS[1] = idem:task:{clientTaskId}
 *
 * ARGV[1] = questionId
 *
 * return idem questionId or nil
 */
export const SET_IDEM_LUA_SCRIPT = `
local cur = redis.call("GET", KEYS[1])
if cur == false then
  -- Key doesn't exist, set it with expiration and return nil
  redis.call("SET", KEYS[1], ARGV[1], "EX", 60)
  return nil
else
  -- Key exists, extend its expiration and return the current value
  redis.call("EXPIRE", KEYS[1], 86400)
  return cur
end
`;