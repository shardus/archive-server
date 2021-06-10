export interface LooseObject {
  [index: string]: any
}

export interface Signature {
  owner: string
  sig: string
}

export interface SignedObject extends LooseObject {
  sign: Signature
}

export enum NodeStatus {
  ACTIVE = 'active',
  SYNCING = 'syncing',
  REMOVED = 'removed',
}

export interface P2PNode {
  publicKey: string
  externalIp: string
  externalPort: number
  internalIp: string
  internalPort: number
  address: string
  joinRequestTimestamp: number
  activeTimestamp: number
}

export interface Node {
  ip: string
  port: number
  publicKey: string
}

export interface NodeInfo {
  curvePublicKey: string
  externalIp: string
  externalPort: number
  id: string
  internalIp: string
  internalPort: number
  publicKey: string
  status: NodeStatus
}

export interface Route<T> {
  method?: string
  name: string
  handler: T
}

export type InternalHandler<
  Payload = unknown,
  Response = unknown,
  Sender = unknown
> = (
  payload: Payload,
  respond: (response?: Response) => void,
  sender: Sender,
  tracker: string
) => void

export type GossipHandler<Payload = unknown, Sender = unknown> = (
  payload: Payload,
  sender: Sender,
  tracker: string
) => void
