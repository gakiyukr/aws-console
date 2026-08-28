import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createSessionValue, parseSessionValue } from "../server/utils/auth.js";
import {
  decryptAwsCredentials,
  encryptAwsCredentials,
  generateCredentialEncryptionKey,
} from "../server/utils/credential-crypto.js";
import { hashPassword, verifyPassword } from "../server/utils/password.js";

describe("AWS 憑證加密", () => {
  it("AES-GCM 加密後可還原完整臨時憑證", async () => {
    const key = generateCredentialEncryptionKey();
    const encrypted = await encryptAwsCredentials({
      accessKeyId: "AKIAEXAMPLE1234",
      secretAccessKey: "secret-value",
      sessionToken: "session-value",
    }, key);

    assert.equal(encrypted.accessKeyHint, "1234");
    assert.ok(!encrypted.credentialCiphertext.includes("secret-value"));
    assert.deepEqual(await decryptAwsCredentials(encrypted, key), {
      accessKeyId: "AKIAEXAMPLE1234",
      secretAccessKey: "secret-value",
      sessionToken: "session-value",
    });
  });

  it("密文遭竄改或主金鑰錯誤時拒絕解密", async () => {
    const encrypted = await encryptAwsCredentials({
      accessKeyId: "AKIAEXAMPLE1234",
      secretAccessKey: "secret-value",
    }, generateCredentialEncryptionKey());
    await assert.rejects(
      decryptAwsCredentials(encrypted, generateCredentialEncryptionKey()),
      /解密失敗/,
    );
  });

  it("拒絕非 32 位元組的加密主金鑰", async () => {
    await assert.rejects(
      encryptAwsCredentials({ accessKeyId: "key", secretAccessKey: "secret" }, btoa("short")),
      /32 位元組/,
    );
  });
});

describe("D1 使用者密碼與 session", () => {
  it("PBKDF2 雜湊可驗證正確密碼並拒絕錯誤密碼", async () => {
    const record = await hashPassword("correct-password", 1000);
    assert.ok(await verifyPassword("correct-password", record));
    assert.equal(await verifyPassword("wrong-password", record), false);
    assert.notEqual(record.passwordHash, "correct-password");
  });

  it("session 綁定 userId 與 authVersion", async () => {
    const now = 1_700_000_000_000;
    const session = await createSessionValue({ userId: 7, authVersion: 3 }, "session-secret", now);
    assert.deepEqual(await parseSessionValue(session, "session-secret", now + 1000), {
      userId: 7,
      authVersion: 3,
      issuedAt: now,
    });
    assert.equal(await parseSessionValue(session, "wrong-secret", now + 1000), null);
  });
});
