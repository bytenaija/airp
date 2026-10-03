import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LocalKMS,
  TenantKeyDestroyedError,
  createLocalKMSFromEnv,
} from "../../packages/common/src/cmek.js";

describe("Customer-Managed Keys (CMEK) and Key Destruction", () => {
  it("proves key destruction equals data destruction: encrypted data becomes permanently unreadable", async () => {
    const kms = new LocalKMS();
    const tenantId = "tenant-enterprise-456";

    const sensitiveDiagnosticData = JSON.stringify({
      incidentId: "b0000000-0000-0000-0000-000000000099",
      secretInternalServiceUrl: "https://internal-payments.corp.local/v1/keys",
      unredactedTraceSnippet: "Authorization failed for database cluster-9",
    });

    // 1. Encrypt tenant data with tenant-specific key
    const ciphertext = await kms.encrypt(sensitiveDiagnosticData, tenantId);
    expect(ciphertext).toBeDefined();
    expect(ciphertext).not.toContain("secretInternalServiceUrl");

    // 2. Decrypt before destruction: should successfully recover original plaintext
    const decrypted = await kms.decrypt(ciphertext, tenantId);
    expect(decrypted).toBe(sensitiveDiagnosticData);

    // 3. Destroy tenant key
    await kms.destroyTenantKey(tenantId);
    expect(kms.isKeyDestroyed(tenantId)).toBe(true);

    // 4. Assert data is now mathematically unreadable: decrypt throws TenantKeyDestroyedError
    await expect(kms.decrypt(ciphertext, tenantId)).rejects.toThrow(TenantKeyDestroyedError);

    // 5. Assert further encryption for this destroyed tenant is denied
    await expect(kms.encrypt("new data", tenantId)).rejects.toThrow(TenantKeyDestroyedError);

    // 6. Assert a fresh KMS instance cannot decrypt the ciphertext of the destroyed key
    const freshKms = new LocalKMS();
    await expect(freshKms.decrypt(ciphertext, tenantId)).rejects.toThrow();
  });

  describe("persistent keystore", () => {
    let dir: string;
    let keystorePath: string;
    const masterKey = crypto.randomBytes(32);

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-kms-"));
      keystorePath = path.join(dir, "keystore.json");
    });
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("decrypts after a restart and keeps tenant keys wrapped at rest", async () => {
      const ciphertext = await new LocalKMS({ keystorePath, masterKey }).encrypt(
        "tenant secret",
        "tenant-a",
      );

      const restarted = new LocalKMS({ keystorePath, masterKey });
      expect(await restarted.decrypt(ciphertext, "tenant-a")).toBe("tenant secret");

      const onDisk = JSON.parse(fs.readFileSync(keystorePath, "utf8"));
      expect(onDisk.keys["tenant-a"].split(":")).toHaveLength(3);
      expect(() => new LocalKMS({ keystorePath, masterKey: crypto.randomBytes(32) })).toThrow();
    });

    it("keeps a destruction made by one process in force for every later process", async () => {
      const service = new LocalKMS({ keystorePath, masterKey });
      const ciphertext = await service.encrypt("tenant secret", "tenant-b");
      await service.encrypt("other tenant", "tenant-c");

      // `airp tenant destroy` runs in its own process with its own instance.
      await new LocalKMS({ keystorePath, masterKey }).destroyTenantKey("tenant-b");

      const restarted = new LocalKMS({ keystorePath, masterKey });
      expect(restarted.isKeyDestroyed("tenant-b")).toBe(true);
      await expect(restarted.decrypt(ciphertext, "tenant-b")).rejects.toThrow(
        TenantKeyDestroyedError,
      );
      await expect(restarted.encrypt("new", "tenant-b")).rejects.toThrow(TenantKeyDestroyedError);
      expect(JSON.parse(fs.readFileSync(keystorePath, "utf8")).keys["tenant-b"]).toBeUndefined();
      expect(restarted.isKeyDestroyed("tenant-c")).toBe(false);
    });

    it("builds from env and refuses the in-memory keystore in production", () => {
      expect(() => createLocalKMSFromEnv({ NODE_ENV: "production" })).toThrow(/AIRP_KMS_KEYSTORE/);
      expect(() => createLocalKMSFromEnv({ AIRP_KMS_KEYSTORE: keystorePath })).toThrow(
        /AIRP_KMS_MASTER_KEY/,
      );
      expect(() =>
        createLocalKMSFromEnv({
          AIRP_KMS_KEYSTORE: keystorePath,
          AIRP_KMS_MASTER_KEY: crypto.randomBytes(16).toString("base64"),
        }),
      ).toThrow(/32 bytes/);

      expect(createLocalKMSFromEnv({ NODE_ENV: "test" }).isPersistent).toBe(false);
      const kms = createLocalKMSFromEnv({
        NODE_ENV: "production",
        AIRP_KMS_KEYSTORE: keystorePath,
        AIRP_KMS_MASTER_KEY: masterKey.toString("base64"),
      });
      expect(kms.isPersistent).toBe(true);
    });
  });
});
