export type hexstring = string
export type publicKey = hexstring
export type secretKey = hexstring | Buffer
export type curvePublicKey = hexstring
export type curveSecretKey = hexstring | Buffer
export type sharedKey = hexstring

export interface Keypair {
  publicKey: publicKey
  secretKey: secretKey
}

export interface Signature {
  owner: publicKey
  sig: hexstring
}

export interface LooseObject {
  [index: string]: any
}

export interface TaggedObject extends LooseObject {
  tag: hexstring
}

export interface SignedObject extends LooseObject {
  sign: Signature
}
