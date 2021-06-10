import * as CycleCreator from './CycleCreatorTypes'
import * as Types from './P2PTypes'

/**
 * [TODO] [AS] Remove nodes that are taking too long to sync after they've joined.
 * To do this, we probably need to keep track of when they first joined.
 */
/** TYPES */

export interface Sign {
  /** The key of the owner */
  owner: string
  /** The hash of the object's signature signed by the owner */
  sig: string
}

export interface JoinedConsensor extends Types.P2PNode {
  cycleJoined: CycleCreator.CycleMarker
  counterRefreshed: CycleCreator.CycleRecord['counter']
  id: string
}

export interface JoinRequest {
  nodeInfo: Types.P2PNode
  cycleMarker: CycleCreator.CycleMarker
  proofOfWork: string
  selectionNum: string
  version: string
  sign: Sign
}

export interface Txs {
  join: JoinRequest[]
}

export interface Record {
  syncing: number
  joinedConsensors: JoinedConsensor[]
}
