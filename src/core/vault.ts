import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';

const HEADER = 0x01;
const NONCE = 12;
const TAG = 16;

/**
 * AES-256-GCM vault, byte-compatible with the Rust implementation it replaces:
 *
 *   secret.key : 32 raw bytes, mode 0600
 *   sealed     : 0x01 | nonce(12) | ciphertext|tag(16)
 *   AAD        : UTF-8 JSON array ["<owner>", "<scope>"] (no spaces)
 *
 * The envelope format preserves compatibility with existing encrypted records.
 */
export class Vault {
  #key: Buffer;

  private constructor(key: Buffer) {
    this.#key = key;
  }

  static open(keyPath: string, hasSecrets: boolean): Vault {
    let key: Buffer;
    try {
      key = fs.readFileSync(keyPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new Error('无法读取 secret.key');
      if (hasSecrets) {
        throw new Error('缺少 secret.key，请恢复原密钥和数据备份；不要重新生成密钥覆盖现有数据');
      }
      key = randomBytes(32);
      fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
    }
    if (key.length !== 32) throw new Error('secret.key 长度不正确，应为 32 字节');
    return new Vault(key);
  }

  #aad(owner: string, scope: string): Buffer {
    return Buffer.from(JSON.stringify([owner, scope]), 'utf8');
  }

  seal(owner: string, scope: string, plaintext: Buffer): Buffer {
    const nonce = randomBytes(NONCE);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(this.#aad(owner, scope));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from([HEADER]), nonce, body, cipher.getAuthTag()]);
  }

  open(owner: string, scope: string, sealed: Buffer): Buffer {
    if (sealed.length < 1 + NONCE + TAG || sealed[0] !== HEADER) {
      throw new Error('无法读取加密凭据：数据格式不正确');
    }
    const nonce = sealed.subarray(1, 1 + NONCE);
    const tag = sealed.subarray(sealed.length - TAG);
    const body = sealed.subarray(1 + NONCE, sealed.length - TAG);
    const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce);
    decipher.setAAD(this.#aad(owner, scope));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(body), decipher.final()]);
    } catch {
      throw new Error('无法读取加密凭据，请恢复原 secret.key 和数据备份');
    }
  }

  sealJson(owner: string, scope: string, value: unknown): Buffer {
    return this.seal(owner, scope, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  openJson<T>(owner: string, scope: string, sealed: Buffer): T {
    return JSON.parse(this.open(owner, scope, sealed).toString('utf8')) as T;
  }
}
