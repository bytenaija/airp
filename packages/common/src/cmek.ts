import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class TenantKeyDestroyedError extends Error {
  constructor(public readonly tenantId: string) {
    super(
      `Customer-managed encryption key for tenant '${tenantId}' has been destroyed. Associated data is permanently unrecoverable.`,
    );
    this.name = "TenantKeyDestroyedError";
  }
}

export interface KMSProvider {
  readonly name: string;
  encrypt(plaintext: string | Buffer, tenantId: string): Promise<string>;
  decrypt(ciphertext: string, tenantId: string): Promise<string>;
  destroyTenantKey(tenantId: string): Promise<void>;
  isKeyDestroyed(tenantId: string): boolean;
}

export interface LocalKMSOptions {
  /**
   * JSON keystore holding tenant keys (wrapped by `masterKey`) and the list of
   * destroyed tenants. Omit for an in-memory keystore that lives only as long
   * as the process, which is suitable for tests and nothing else.
   */
  keystorePath?: string;
  /** 32-byte key that wraps tenant keys at rest. Required with keystorePath. */
  masterKey?: Buffer;
}

interface KeystoreFile {
  version: 1;
  keys: Record<string, string>;
  destroyed: string[];
}

function sealAesGcm(key: Buffer, plaintext: Buffer): string {
  const iv = crypto.randomBytes(12); // 96-bit IV for AES-GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv:tag:ciphertext in base64
  return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function openAesGcm(key: Buffer, sealed: string): Buffer {
  const parts = sealed.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid ciphertext format. Expected iv:tag:encrypted");
  }
  const [ivB64, tagB64, encB64] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encB64, "base64")),
    decipher.final(),
  ]);
}

/**
 * Local CMEK implementation: one random AES-256-GCM key per tenant.
 *
 * With a keystore, tenant keys are persisted wrapped by the master key and the
 * destroyed-tenant list is persisted too, so destruction survives restarts and
 * holds across processes (the `airp tenant destroy` CLI and the services).
 * Without one, keys and destruction records vanish with the process.
 */
export class LocalKMS implements KMSProvider {
  readonly name = "LocalKMS";
  private tenantKeys = new Map<string, Buffer>();
  private destroyedKeys = new Set<string>();
  private readonly keystorePath?: string;
  private readonly masterKey?: Buffer;

  constructor(options: LocalKMSOptions = {}) {
    if (options.keystorePath) {
      if (!options.masterKey || options.masterKey.length !== 32) {
        throw new Error(
          "LocalKMS keystore requires a 32-byte master key to wrap tenant keys at rest",
        );
      }
      this.keystorePath = path.resolve(options.keystorePath);
      this.masterKey = options.masterKey;
      this.load();
    }
  }

  get isPersistent(): boolean {
    return this.keystorePath !== undefined;
  }

  private load(): void {
    if (!this.keystorePath || !fs.existsSync(this.keystorePath)) return;
    const store = JSON.parse(
      fs.readFileSync(this.keystorePath, "utf8"),
    ) as KeystoreFile;
    for (const tenantId of store.destroyed ?? []) {
      this.destroyedKeys.add(tenantId);
    }
    for (const [tenantId, wrapped] of Object.entries(store.keys ?? {})) {
      this.tenantKeys.set(tenantId, openAesGcm(this.masterKey!, wrapped));
    }
  }

  private persist(): void {
    if (!this.keystorePath) return;
    const store: KeystoreFile = {
      version: 1,
      keys: Object.fromEntries(
        [...this.tenantKeys].map(([tenantId, key]) => [
          tenantId,
          sealAesGcm(this.masterKey!, key),
        ]),
      ),
      destroyed: [...this.destroyedKeys],
    };
    fs.mkdirSync(path.dirname(this.keystorePath), { recursive: true });
    // Write then rename so a crash never leaves a half-written keystore.
    const tmpPath = `${this.keystorePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmpPath, this.keystorePath);
  }

  private getOrCreateKey(tenantId: string): Buffer {
    if (this.destroyedKeys.has(tenantId)) {
      throw new TenantKeyDestroyedError(tenantId);
    }
    let key = this.tenantKeys.get(tenantId);
    if (!key) {
      // Generate a true random 256-bit AES key for the tenant
      key = crypto.randomBytes(32);
      this.tenantKeys.set(tenantId, key);
      this.persist();
    }
    return key;
  }

  isKeyDestroyed(tenantId: string): boolean {
    return this.destroyedKeys.has(tenantId);
  }

  async encrypt(plaintext: string | Buffer, tenantId: string): Promise<string> {
    const key = this.getOrCreateKey(tenantId);
    const inputBuf =
      typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    return sealAesGcm(key, inputBuf);
  }

  async decrypt(ciphertext: string, tenantId: string): Promise<string> {
    if (this.destroyedKeys.has(tenantId)) {
      throw new TenantKeyDestroyedError(tenantId);
    }
    const key = this.tenantKeys.get(tenantId);
    if (!key) {
      throw new Error(`No encryption key exists for tenant '${tenantId}'`);
    }
    return openAesGcm(key, ciphertext).toString("utf8");
  }

  async destroyTenantKey(tenantId: string): Promise<void> {
    const key = this.tenantKeys.get(tenantId);
    if (key) {
      // Overwrite key bytes with zero to ensure cryptographic destruction in memory
      key.fill(0);
      this.tenantKeys.delete(tenantId);
    }
    this.destroyedKeys.add(tenantId);
    this.persist();
  }
}

/**
 * Builds the LocalKMS for this process from AIRP_KMS_KEYSTORE and
 * AIRP_KMS_MASTER_KEY (base64, 32 bytes). Production refuses the in-memory
 * keystore, because a destruction it records is forgotten on restart.
 */
export function createLocalKMSFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LocalKMS {
  const keystorePath = env.AIRP_KMS_KEYSTORE;
  if (!keystorePath) {
    if (env.NODE_ENV === "production") {
      throw new Error(
        "AIRP_KMS_KEYSTORE and AIRP_KMS_MASTER_KEY must be set in production; the in-memory LocalKMS cannot make key destruction durable",
      );
    }
    return new LocalKMS();
  }
  const masterKeyB64 = env.AIRP_KMS_MASTER_KEY;
  if (!masterKeyB64) {
    throw new Error("AIRP_KMS_KEYSTORE is set but AIRP_KMS_MASTER_KEY is missing");
  }
  const masterKey = Buffer.from(masterKeyB64, "base64");
  if (masterKey.length !== 32) {
    throw new Error("AIRP_KMS_MASTER_KEY must decode to exactly 32 bytes");
  }
  return new LocalKMS({ keystorePath, masterKey });
}

let globalKMS: LocalKMS | undefined;

/** Process-wide KMS for the local runtime and CLI, created on first use. */
export function getGlobalKMS(): LocalKMS {
  globalKMS ??= createLocalKMSFromEnv();
  return globalKMS;
}
