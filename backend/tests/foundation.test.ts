import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { createBearerToken, hashBearerToken } from "../src/auth/token.js";

const baseEnv = {
  CORS_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "postgres://example:example@localhost:5432/gargantua",
  QUOTE_SECRET: "0123456789abcdef0123456789abcdef",
};

test("config requires a quote secret of at least 32 characters", () => {
  assert.throws(() => parseConfig({ ...baseEnv, QUOTE_SECRET: "short" }), /QUOTE_SECRET/);
  assert.throws(() => parseConfig({ ...baseEnv, ADMIN_API_TOKEN: "short" }), /ADMIN_API_TOKEN/);
  assert.equal(parseConfig({ ...baseEnv, ADMIN_API_TOKEN: "" }).ADMIN_API_TOKEN, undefined);
  assert.equal(parseConfig(baseEnv).QUOTE_TTL_MS, 15_000);
});

test("price cache TTL cannot reach the maximum permitted price age", () => {
  assert.throws(() => parseConfig({ ...baseEnv, PRICE_CACHE_TTL_MS: "1000", MAX_PRICE_AGE_MS: "1000" }), /must be below MAX_PRICE_AGE_MS/);
});

test("bearer tokens are random, URL-safe, and only persist as SHA-256 hashes", () => {
  const first = createBearerToken();
  const second = createBearerToken();
  assert.match(first, /^[A-Za-z0-9_-]{40,}$/);
  assert.notEqual(first, second);
  assert.match(hashBearerToken(first), /^[a-f0-9]{64}$/);
  assert.notEqual(hashBearerToken(first), first);
  assert.equal(hashBearerToken(first), hashBearerToken(first));
});
