import { NetworkHash } from '../State'

/** TYPES */

export interface Record {
  networkDataHash: NetworkHash[]
  networkReceiptHash: NetworkHash[]
  networkSummaryHash: NetworkHash[]
}
