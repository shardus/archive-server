import { CycleMarker, CycleRecord as Cycle } from '../Cycle/CycleCreatorTypes'

/** TYPES */

export type NetworkStateHash = string
export type NetworkReceiptHash = string
export type NetworkSummarytHash = string

export interface NetworkHash {
  cycle: number
  hash: string
}

export interface StateHashes {
  counter: Cycle['counter']
  partitionHashes: object
  networkHash: NetworkStateHash
}

export interface ReceiptHashes {
  counter: Cycle['counter']
  receiptMapHashes: object
  networkReceiptHash: NetworkReceiptHash
}

export interface SummaryHashes {
  counter: Cycle['counter']
  summaryHashes: object
  networkSummaryHash: NetworkSummarytHash
}

export interface Transaction {
  id: string
}

export interface StateMetaData {
  counter: Cycle['counter']
  stateHashes: StateHashes[]
  receiptHashes: ReceiptHashes[]
  summaryHashes: SummaryHashes[]
}

export type ReceiptMap = { [txId: string]: string[] }

export type ReceiptMapResult = {
  cycle: number
  partition: number
  receiptMap: ReceiptMap
  txCount: number
}

export type OpaqueBlob = any //Shardus is not supposed to know about the details of this, it is up to the dapp to define

//Shardus wrapper for a summary blob.  Has information that is needed for the reduce algorithm
export type SummaryBlob = {
  latestCycle: number //The highest cycle that was used in this summary.
  counter: number
  errorNull: number
  partition: number
  opaqueBlob: OpaqueBlob
}

//A collection of blobs that share the same cycle.  For TX summaries
export type SummaryBlobCollection = {
  cycle: number
  blobsByPartition: Map<number, SummaryBlob>
}

// Stats collected for a cycle
export type StatsClump = {
  error: boolean
  cycle: number
  dataStats: SummaryBlob[]
  txStats: SummaryBlob[]
  covered: number[]
  coveredParititionCount: number
  skippedParitionCount: number
}

export type StateData = {
  parentCycle?: CycleMarker
  networkHash?: string
  partitionHashes?: string[]
}

export type Receipt = {
  parentCycle?: CycleMarker
  networkHash?: string
  partitionHashes?: string[]
  partitionMaps?: { [partition: number]: ReceiptMapResult }
  partitionTxs?: { [partition: number]: any }
}

export type Summary = {
  parentCycle?: CycleMarker
  networkHash?: string
  partitionHashes?: string[]
  partitionBlobs?: { [partition: number]: SummaryBlob }
}
