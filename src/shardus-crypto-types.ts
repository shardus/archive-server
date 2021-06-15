export type hexstring = string
export type publicKey = hexstring
export type secretKey = hexstring
export type curvePublicKey = hexstring
export type curveSecretKey = hexstring
export type sharedKey = Buffer

export interface Keypair {
  publicKey: publicKey
  secretKey: secretKey
}
