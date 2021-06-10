import { CycleRecord as Cycle } from './CycleCreatorTypes'
import { SignedObject } from './P2PTypes'
import { StateMetaData } from '../State'

/** TYPES */

export enum RequestTypes {
  JOIN = 'JOIN',
  LEAVE = 'LEAVE',
}
export interface NamesToTypes {
  CYCLE: Cycle
  STATE_METADATA: StateMetaData
}

export type ValidTypes = Cycle | StateMetaData

export enum TypeNames {
  CYCLE = 'CYCLE',
  STATE_METADATA = 'STATE_METADATA',
}

export type TypeName<T extends ValidTypes> = T extends Cycle
  ? TypeNames.CYCLE
  : TypeNames.STATE_METADATA

export type TypeIndex<T extends ValidTypes> = T extends Cycle
  ? Cycle['counter']
  : StateMetaData['counter']

export interface DataRequest<T extends ValidTypes> {
  type: TypeName<T>
  lastData: TypeIndex<T>
}

export interface DataResponse {
  publicKey: string
  responses: {
    [T in TypeNames]?: NamesToTypes[T][]
  }
  recipient: string
}
export interface DataRecipient {
  nodeInfo: JoinedArchiver
  dataRequests: DataRequest<Cycle | StateMetaData>[]
  curvePk: string
}

export interface JoinedArchiver {
  publicKey: string
  ip: string
  port: number
  curvePk: string
}

export interface Request extends SignedObject {
  nodeInfo: JoinedArchiver
  requestType: string
}
export interface Txs {
  archivers: Request[]
}

export interface Record {
  joinedArchivers: JoinedArchiver[]
  leavingArchivers: JoinedArchiver[]
}
