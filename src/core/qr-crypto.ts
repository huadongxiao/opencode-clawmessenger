const QR_SECRET = 'dm_im_qr_key_v2_2026_secure';
const QR_SALT = 'qr_salt_x9k2';

function deriveKey(): number[] {
  const input = QR_SECRET + QR_SALT;
  const key = [];
  for (let i = 0; i < 32; i++) {
    let h = 0;
    for (let j = 0; j < input.length; j++) {
      h = ((h << 5) - h + input.charCodeAt((i + j) % input.length)) | 0;
    }
    key.push(h & 0xff);
  }
  return key;
}

function randomBytes(n: number): number[] {
  const bytes = [];
  for (let i = 0; i < n; i++) {
    bytes.push(Math.floor(Math.random() * 256));
  }
  return bytes;
}

function stringToUtf8Bytes(str: string): number[] {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return bytes;
}

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64url(bytes: number[]): string {
  let res = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    res += B64U[a >> 2];
    res += B64U[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) res += B64U[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) res += B64U[c & 63];
  }
  return res;
}

export function encryptQR(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(4);
  const plainBytes = stringToUtf8Bytes(plaintext);

  const cipherBytes = [];
  for (let i = 0; i < plainBytes.length; i++) {
    const keyIdx = (i + iv[i % 4]) % 32;
    cipherBytes.push(plainBytes[i] ^ key[keyIdx]);
  }

  const payload = [...iv, ...cipherBytes];
  return 'v3:' + toBase64url(payload);
}
