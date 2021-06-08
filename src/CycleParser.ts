import { reversed } from './Utils'
import { NetworkHash } from './Data/StateParser'

/** TYPES */

export type CycleMarker = string

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

export interface JoinedConsensor extends P2PNode {
  cycleJoined: CycleMarker
  counterRefreshed: CycleRecord['counter']
  id: string
}

export interface JoinedArchiver {
  publicKey: string
  ip: string
  port: number
  curvePk: string
}

export enum NodeStatus {
  ACTIVE = 'active',
  SYNCING = 'syncing',
  REMOVED = 'removed',
}

export interface Node extends JoinedConsensor {
  curvePublicKey: string
  status: NodeStatus
}

type OptionalExceptFor<T, TRequired extends keyof T> = Partial<T> &
  Pick<T, TRequired>

export type Update = OptionalExceptFor<Node, 'id'>

export interface BaseRecord {
  networkId: string
  counter: number
  previous: string
  start: number
  duration: number
}

export interface SafetyModeRecord {
  safetyMode: boolean
  safetyNum: number
  networkStateHash: string
}

export interface RefreshRecord {
  refreshedArchivers: JoinedArchiver[]
  refreshedConsensors: Node[]
}

export interface ArchiverRecord {
  joinedArchivers: JoinedArchiver[]
  leavingArchivers: JoinedArchiver[]
}

export interface JoinRecord {
  syncing: number
  joinedConsensors: JoinedConsensor[]
}

export interface ActiveRecord {
  active: number
  activated: string[]
  activatedPublicKeys: string[]
}

export interface ApoptosisRecord {
  apoptosized: string[]
}

export interface LostCycleRecord {
  lost: string[],
  refuted: string[]
}

export interface RotationRecord {
  expired: number
  removed: string[]
}

export interface SnapshotRecord {
  networkDataHash: NetworkHash[]
  networkReceiptHash: NetworkHash[]
  networkSummaryHash: NetworkHash[]
}

export interface CycleAutoScaleRecord {
  desired: number
}

export type CycleRecord = BaseRecord &
  SafetyModeRecord &
  RefreshRecord &
  ArchiverRecord &
  JoinRecord &
  ActiveRecord &
  ApoptosisRecord &
  LostCycleRecord &
  RotationRecord & {
    joined: string[]
    returned: string[]
    lost: string[]
    refuted: string[]
    apoptosized: string[]
  } & SnapshotRecord &
    CycleAutoScaleRecord

export interface Change {
  added: JoinedConsensor[] // order joinRequestTimestamp [OLD, ..., NEW]
  removed: Array<Node['id']> // order doesn't matter
  updated: Update[] // order doesn't matter
}

export class ChangeSquasher {
  final: Change
  removedIds: Set<Node['id']>
  seenUpdates: Map<Update['id'], Update>
  addedIds: Set<Node['id']>
  constructor() {
    this.final = {
      added: [],
      removed: [],
      updated: [],
    }
    this.addedIds = new Set()
    this.removedIds = new Set()
    this.seenUpdates = new Map()
  }

  addChange(change: Change) {
    for (const id of change.removed) {
      // Ignore if id is already removed
      if (this.removedIds.has(id)) continue
      // Mark this id as removed
      this.removedIds.add(id)
    }

    for (const update of change.updated) {
      // Ignore if update.id is already removed
      if (this.removedIds.has(update.id)) continue
      // Mark this id as updated
      this.seenUpdates.set(update.id, update)
    }

    for (const joinedConsensor of reversed(change.added)) {
      // Ignore if it's already been added
      if (this.addedIds.has(joinedConsensor.id)) continue

      // Ignore if joinedConsensor.id is already removed
      if (this.removedIds.has(joinedConsensor.id)) {
        continue
      }
      // Check if this id has updates
      const update = this.seenUpdates.get(joinedConsensor.id)
      if (update) {
        // If so, put them into final.updated
        this.final.updated.unshift(update)
        this.seenUpdates.delete(joinedConsensor.id)
      }
      // Add joinedConsensor to final.added
      this.final.added.unshift(joinedConsensor)
      // Mark this id as added
      this.addedIds.add(joinedConsensor.id)
    }
  }
}
