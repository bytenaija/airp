import { describe, it, expect } from "vitest";
import { LocalKMS, TenantKeyDestroyedError } from "../../packages/common/src/cmek.js";

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
  });
});
