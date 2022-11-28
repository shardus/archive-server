declare module 'shardus-crypto-types' {
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
}

declare module '@shardus/crypto-utils' {
  import * as CryptoTypes from 'shardus-crypto-types'

  interface ShardusCrypto {
    init: (hashKey: CryptoTypes.hexstring) => void
    hashObj: (
      obj: CryptoTypes.LooseObject,
      removeSign?: boolean,
      removeTag?: boolean
    ) => CryptoTypes.hexstring
    generateKeypair: (opts?: { getSecretAsBuffer?: boolean }) => CryptoTypes.Keypair
    stringify: (obj: CryptoTypes.LooseObject) => string
    signObj: (
      obj: CryptoTypes.LooseObject,
      secretKey: CryptoTypes.secretKey,
      publicKey: CryptoTypes.publicKey
    ) => void
    verifyObj: (obj: CryptoTypes.SignedObject) => boolean
    tagObj: (obj: CryptoTypes.LooseObject, sharedK: CryptoTypes.sharedKey) => void
    authenticateObj: (obj: CryptoTypes.TaggedObject, sharedK: CryptoTypes.sharedKey) => boolean
    convertSkToCurve: (
      sk: CryptoTypes.secretKey,
      opts?: {
        getAsBuffer?: boolean
      }
    ) => CryptoTypes.curveSecretKey
    convertPkToCurve: (pk: CryptoTypes.publicKey) => CryptoTypes.curvePublicKey
    generateSharedKey: (
      curveSk: CryptoTypes.curveSecretKey,
      curvePk: CryptoTypes.curvePublicKey
    ) => CryptoTypes.sharedKey

    hash(input: string): CryptoTypes.hexstring
  }

  const crypto: ShardusCrypto

  export = crypto
}

declare module 'minimist'
