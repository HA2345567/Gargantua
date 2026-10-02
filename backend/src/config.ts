import { z } from "zod";

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  return value.toLowerCase() === "true";
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  CORS_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: booleanFromEnv.default(false),
  QUOTE_SECRET: z.string().min(32),
  PRIVY_APP_ID: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  PRIVY_VERIFICATION_KEY: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  SOLANA_PROGRAM_ID: z.string().optional(),
  SOLANA_ESCROW_MINT: z.string().optional(),
  SOLANA_QUOTE_SIGNER_PRIVATE_KEY_PEM: z.string().optional(),
  SOLANA_RPC_URL: z.string().url().default("https://api.devnet.solana.com"),
  SOLANA_SETTLEMENT_SIGNER_KEYPAIRS: z.preprocess((value) => value === "" ? undefined : value, z.string().optional()),
  ADMIN_API_TOKEN: z.preprocess((value) => value === "" ? undefined : value, z.string().min(32).optional()),
  STARTING_BALANCE: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/).default("1000"),
  HOUSE_EDGE: z.string().regex(/^0\.\d{1,10}$/).default("0.05"),
  MIN_STAKE: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/).default("1"),
  MAX_STAKE: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/).default("100"),
  MAX_PAYOUT: z.string().regex(/^(0|[1-9]\d{0,11})(\.\d{1,6})?$/).default("10000"),
  MAX_HORIZON_DAYS: z.coerce.number().int().positive().default(90),
  MAX_PRICE_AGE_MS: z.coerce.number().int().positive().max(5000).default(5000),
  PRICE_CACHE_TTL_MS: z.coerce.number().int().positive().max(4999).default(1500),
  QUOTE_TTL_MS: z.coerce.number().int().positive().max(15000).default(15000),
  CATALOG_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  CATALOG_FULL_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),
  CATALOG_MAX_MARKETS: z.coerce.number().int().positive().default(500),
  SETTLEMENT_INTERVAL_MS: z.coerce.number().int().positive().default(60000),
  SETTLEMENT_ALERT_DAYS: z.coerce.number().int().positive().default(3),
  KALSHI_BASE_URL: z.string().url().default("https://external-api.kalshi.com/trade-api/v2"),
  KALSHI_ACCESS_KEY: z.string().optional(),
  KALSHI_PRIVATE_KEY_PEM: z.string().optional(),
  POLYMARKET_GAMMA_URL: z.string().url().default("https://gamma-api.polymarket.com"),
  POLYMARKET_CLOB_URL: z.string().url().default("https://clob.polymarket.com"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function parseConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid backend configuration: ${issues}`);
  }
  if (parsed.data.PRICE_CACHE_TTL_MS >= parsed.data.MAX_PRICE_AGE_MS) {
    throw new Error("Invalid backend configuration: PRICE_CACHE_TTL_MS must be below MAX_PRICE_AGE_MS");
  }
  if (Boolean(parsed.data.KALSHI_ACCESS_KEY) !== Boolean(parsed.data.KALSHI_PRIVATE_KEY_PEM)) {
    throw new Error("Invalid backend configuration: KALSHI_ACCESS_KEY and KALSHI_PRIVATE_KEY_PEM must be configured together");
  }
  if (Boolean(parsed.data.PRIVY_APP_ID) !== Boolean(parsed.data.PRIVY_VERIFICATION_KEY)) {
    throw new Error("Invalid backend configuration: PRIVY_APP_ID and PRIVY_VERIFICATION_KEY must be configured together");
  }
  if (parsed.data.NODE_ENV === "production" && !parsed.data.PRIVY_APP_ID) {
    throw new Error("Invalid backend configuration: Privy authentication must be configured in production");
  }
  const solanaSettings = [parsed.data.SOLANA_PROGRAM_ID, parsed.data.SOLANA_ESCROW_MINT, parsed.data.SOLANA_QUOTE_SIGNER_PRIVATE_KEY_PEM];
  if (solanaSettings.some(Boolean) && !solanaSettings.every(Boolean)) {
    throw new Error("Invalid backend configuration: SOLANA_PROGRAM_ID, SOLANA_ESCROW_MINT, and SOLANA_QUOTE_SIGNER_PRIVATE_KEY_PEM must be configured together");
  }
  if (parsed.data.SOLANA_SETTLEMENT_SIGNER_KEYPAIRS) {
    try {
      const keys = JSON.parse(parsed.data.SOLANA_SETTLEMENT_SIGNER_KEYPAIRS) as unknown;
      if (!Array.isArray(keys) || keys.length < 1 || keys.length > 5 || keys.some((key) => !Array.isArray(key) || key.length !== 64 || key.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255))) throw new Error();
    } catch {
      throw new Error("Invalid backend configuration: SOLANA_SETTLEMENT_SIGNER_KEYPAIRS must be a JSON array of 1–5 Solana 64-byte secret key arrays");
    }
  }
  const micros = (value: string) => { const [whole, fraction = ""] = value.split("."); return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0") || "0"); };
  if (micros(parsed.data.MIN_STAKE) <= 0n || micros(parsed.data.MAX_STAKE) < micros(parsed.data.MIN_STAKE) || micros(parsed.data.MAX_PAYOUT) <= 0n) throw new Error("Invalid backend configuration: stake and payout limits are inconsistent");
  return parsed.data;
}
