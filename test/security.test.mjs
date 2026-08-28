import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  decryptAwsCredentials,
  encryptAwsCredentials,
  generateCredentialEncryptionKey,
} from "../server/utils/credential-crypto.js";

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
