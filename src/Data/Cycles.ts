import * as Storage from '../Storage'
import * as NodeList from '../NodeList'
import * as Crypto from '../Crypto'
import { safeParse } from '../Utils'
import * as State from '../State'
import * as Logger from '../Logger'
import { NodeStatus, CycleRecord } from '../CycleParser'

export interface Cycle extends CycleRecord {
  certificate: string
  marker: string
}

export let currentCycleDuration = 0
export let currentCycleCounter = -1
export let lastProcessedMetaData = -1
export let CycleChain: Map<Cycle["counter"], any> = new Map()

export function processCycles(cycles: Cycle[]) {
  for (const cycle of cycles) {
    Logger.mainLogger.debug(new Date(), 'New Cycle received', cycle.counter)
    Logger.mainLogger.debug('Current cycle counter', currentCycleCounter)
    // Skip if already processed [TODO] make this check more secure
    if (cycle.counter <= currentCycleCounter) continue

    // Update NodeList from cycle info
    updateNodeList(cycle)

    // Update currentCycle state
    currentCycleDuration = cycle.duration * 1000
    currentCycleCounter = cycle.counter

    Logger.mainLogger.debug(`Processed cycle ${cycle.counter}`)
  }
}

export function getCurrentCycleCounter() {
  return currentCycleCounter
}

export function setCurrentCycleCounter(value: number) {
  currentCycleCounter = value
}

export function setLastProcessedMetaDataCounter(value: number) {
  lastProcessedMetaData = value
}

export function computeCycleMarker(fields: any) {
  const cycleMarker = Crypto.hashObj(fields)
  return cycleMarker
}

// validation of cycle record against previous marker
export function validateCycle(prev: Cycle, next: Cycle): boolean {
  let previousRecordWithoutMarker: any = {...prev}
  delete previousRecordWithoutMarker.marker
  const prevMarker = computeCycleMarker(previousRecordWithoutMarker)
  if (next.previous !== prevMarker) return false
  return true
}


function updateNodeList(cycle: Cycle) {

  const { joinedConsensors, activatedPublicKeys, removed, lost, apoptosized, joinedArchivers, leavingArchivers, } = cycle

  // Add joined nodes
  // const joinedConsensors = safeParse<JoinedConsensor[]>(
  //   [],
  //   cycle.joinedConsensors,
  //   `Error processing cycle ${cycle.counter}: failed to parse joinedConsensors`
  // )

  const consensorInfos = joinedConsensors.map((jc) => ({
    ip: jc.externalIp,
    port: jc.externalPort,
    publicKey: jc.publicKey,
    id: jc.id,
  }))

  NodeList.addNodes(NodeStatus.SYNCING, cycle.marker, consensorInfos)

  // Update activated nodes
  // const activatedPublicKeys = safeParse<string[]>(
  //   [],
  //   cycle.activatedPublicKeys,
  //   `Error processing cycle ${cycle.counter}: failed to parse activated`
  // )
  NodeList.setStatus(NodeStatus.ACTIVE, ...activatedPublicKeys)

  // Remove removed nodes
  // const removed = safeParse<string[]>(
  //   [],
  //   cycle.removed,
  //   `Error processing cycle ${cycle.counter}: failed to parse removed`
  // )
  const removedPks = removed.reduce((keys: string[], id) => {
    const nodeInfo = NodeList.getNodeInfoById(id)
    if (nodeInfo) {
      keys.push(nodeInfo.publicKey)
    }
    return keys
  }, [])
  NodeList.removeNodes(removedPks)

  // Remove lost nodes
  // const lost = safeParse<string[]>(
  //   [],
  //   cycle.lost,
  //   `Error processing cycle ${cycle.counter}: failed to parse lost`
  // )
  const lostPks = lost.reduce((keys: string[], id) => {
    const nodeInfo = NodeList.getNodeInfoById(id)
    if (nodeInfo) {
      keys.push(nodeInfo.publicKey)
    }
    return keys
  }, [])
  NodeList.removeNodes(lostPks)

  // Remove apoptosized nodes
  // const apoptosized = safeParse<string[]>(
  //   [],
  //   cycle.apoptosized,
  //   `Error processing cycle ${cycle.counter}: failed to parse apoptosized`
  // )
  const apoptosizedPks = apoptosized.reduce((keys: string[], id) => {
    const nodeInfo = NodeList.getNodeInfoById(id)
    if (nodeInfo) {
      keys.push(nodeInfo.publicKey)
    }
    return keys
  }, [])
  NodeList.removeNodes(apoptosizedPks)
  // const joinedArchivers = safeParse<State.ArchiverNodeState[]>(
  //   [],
  //   cycle.joinedArchivers,
  //   `Error processing cycle ${cycle.counter}: failed to parse joinedArchivers`
  // )
  for (let joinedArchiver of joinedArchivers) {
    let foundArchiver = State.activeArchivers.find(a => a.publicKey === joinedArchiver.publicKey)
    if (!foundArchiver) {
      State.activeArchivers.push(joinedArchiver)
      Logger.mainLogger.debug('New archiver added to active list', joinedArchiver)
    }
    Logger.mainLogger.debug('active archiver list', State.activeArchivers)
  }

  // const leavingArchivers = safeParse<State.ArchiverNodeState[]>(
  //   [],
  //   cycle.leavingArchivers,
  //   `Error processing cycle ${cycle.counter}: failed to parse joinedArchivers`
  // )
  for (let leavingArchiver of leavingArchivers) {
    State.removeActiveArchiver(leavingArchiver.publicKey)
  }
}
