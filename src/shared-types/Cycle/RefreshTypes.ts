import * as Archivers from './ArchiversTypes'
import * as NodeList from './NodeListTypes'

/** TYPES */

export interface Txs {}

export interface Record {
  refreshedArchivers: Archivers.JoinedArchiver[]
  refreshedConsensors: NodeList.Node[]
}
