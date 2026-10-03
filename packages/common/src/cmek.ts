import crypto from "node:crypto";

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

export class LocalKMS implements KMSProvider {
  readonly name = "LocalKMS";
  private tenantKeys = new Map<string, Buffer>();
  private destroyedKeys = new Set<string>();

  private getOrCreateKey(tenantId: string): Buffer {
    if (this.destroyedKeys.has(tenantId)) {
      throw new TenantKeyDestroyedError(tenantId);
    }
    let key = this.tenantKeys.get(tenantId);
    if (!key) {
      // Generate a true random 256-bit AES key for the tenant
      key = crypto.randomBytes(32);
      this.tenantKeys.set(tenantId, key);
    }
    return key;
  }

  isKeyDestroyed(tenantId: string): boolean {
    return this.destroyedKeys.has(tenantId);
  }

  async encrypt(plaintext: string | Buffer, tenantId: string): Promise<string> {
    if (this.destroyedKeys.has(tenantId)) {
      throw new TenantKeyDestroyedError(tenantId);
    }
    const key = this.getOrCreateKey(tenantId);
    const iv = crypto.randomBytes(12); // 96-bit IV for AES-GCM
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);

    const inputBuf = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext;
    const encrypted = Buffer.concat([cipher.update(inputBuf), cipher.final()]);
    const tag = cipher.getAuthTag();

    // Format: iv:tag:ciphertext in base64
    return `${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
  }

  async decrypt(ciphertext: string, tenantId: string): Promise<string> {
    if (this.destroyedKeys.has(tenantId)) {
      throw new TenantKeyDestroyedError(tenantId);
    }
    const key = this.getOrCreateKey(tenantId);
    const parts = ciphertext.split(":");
    if (parts.length !== 3) {
      throw new Error("Invalid ciphertext format. Expected iv:tag:encrypted");
    }

    const [ivB64, tagB64, encB64] = parts;
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const encrypted = Buffer.from(encB64, "base64");

    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  }

  async destroyTenantKey(tenantId: string): Promise<void> {
    const key = this.tenantKeys.get(tenantId);
    if (key) {
      // Overwrite key bytes with zero to ensure cryptographic destruction in memory
      key.fill(0);
      this.tenantKeys.delete(tenantId);
    }
    this.destroyedKeys.add(tenantId);
  }
}

// Global singleton for local runtime and CLI operations
export const globalKMS = new LocalKMS();
