import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { rotateDemoCredentials } from "../../packages/common/src/credentials.js";
import { LocalAuth, signJwt } from "../../packages/common/src/auth.js";

describe("Secrets Management & Rotation Drill", () => {
  let tempEnvFile: string;
  let tempDir: string;
  const initialJwtSecret = "initial_secret_prior_to_rotation_12345";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "airp-secrets-test-"));
    tempEnvFile = path.join(tempDir, ".env");
    fs.writeFileSync(
      tempEnvFile,
      `JWT_SECRET=${initialJwtSecret}\nSERVICE_ACCOUNT_SECRET=old_service_secret\nCANARY_SECRET=old_canary_secret\n`,
      "utf8",
    );
    process.env.JWT_SECRET = initialJwtSecret;
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("rotates demo credentials end to end, updating environment and configuration", async () => {
    // Mint token using old secret before rotation
    const oldToken = signJwt({ sub: "user-1", tenant_id: "local" }, initialJwtSecret, 3600);

    // Verify token works before rotation
    const authBefore = new LocalAuth(process.env.JWT_SECRET);
    const userBefore = await authBefore.authenticate(oldToken);
    expect(userBefore.id).toBe("user-1");

    // Execute secret rotation drill
    const result = rotateDemoCredentials({ envPath: tempEnvFile });

    expect(result.rotatedKeys).toContain("JWT_SECRET");
    expect(result.rotatedKeys).toContain("SERVICE_ACCOUNT_SECRET");
    expect(result.rotatedKeys).toContain("CANARY_SECRET");
    expect(result.auditLog).toContain("[SECRET_ROTATION]");

    // Verify process.env has updated
    expect(process.env.JWT_SECRET).not.toBe(initialJwtSecret);
    expect(process.env.JWT_SECRET).toMatch(/^airp_jwt_[a-f0-9]{48}$/);

    // Verify .env file on disk was updated
    const updatedEnvContent = fs.readFileSync(tempEnvFile, "utf8");
    expect(updatedEnvContent).toContain(`JWT_SECRET=${process.env.JWT_SECRET}`);

    // Verify that new LocalAuth rejects old token
    const authAfter = new LocalAuth(process.env.JWT_SECRET);
    await expect(authAfter.authenticate(oldToken)).rejects.toThrow("Invalid JWT signature");

    // Verify new token minted with rotated secret works
    const newToken = await authAfter.createToken({ id: "user-after-rotation" });
    const userAfter = await authAfter.authenticate(newToken);
    expect(userAfter.id).toBe("user-after-rotation");
  });
});
