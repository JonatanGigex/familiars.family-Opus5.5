import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import nacl from 'tweetnacl'

/** Accepts a base58 64-byte secret key or a solana-keygen JSON array. */
export function keypairFromSecret(secret: string): Keypair {
  const trimmed = secret.trim()
  const bytes = trimmed.startsWith('[') ? Uint8Array.from(JSON.parse(trimmed) as number[]) : bs58.decode(trimmed)
  if (bytes.length !== 64) throw new Error(`secret key must be 64 bytes, got ${bytes.length}`)
  return Keypair.fromSecretKey(bytes)
}

export function generateKeypair(): Keypair {
  return Keypair.generate()
}

export function secretToBase58(kp: Keypair): string {
  return bs58.encode(kp.secretKey)
}

/** ed25519 signature over the UTF-8 bytes of `message`, as familiars expects. */
export function signMessage(kp: Keypair, message: string): { base64: string; base58: string } {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey)
  return { base64: Buffer.from(sig).toString('base64'), base58: bs58.encode(sig) }
}

export function verifyMessage(publicKeyBase58: string, message: string, signatureBase64: string): boolean {
  return nacl.sign.detached.verify(
    new TextEncoder().encode(message),
    Buffer.from(signatureBase64, 'base64'),
    bs58.decode(publicKeyBase58),
  )
}
