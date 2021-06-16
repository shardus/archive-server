import { Server, IncomingMessage, ServerResponse } from 'http'
import { EventEmitter } from 'events'
import * as deepmerge from 'deepmerge'
import fastify = require('fastify')
import * as Crypto from '../Crypto'
import * as NodeList from '../NodeList'
import * as Storage from '../Storage'
import * as Cycles from './Cycles'
import * as State from '../State'
import * as P2P from '../P2P'
import { Utils, P2PUtils, SyncUtils, Changer, P2PTypes, ArchiversTypes ,StateTypes} from 'shardus-parser'
import * as Gossip from './Gossip'
import { isDeepStrictEqual } from 'util'
import { config, Config } from '../Config'

import {
  Cycle,
  currentCycleCounter,
  currentCycleDuration,
  processCycles,
  lastProcessedMetaData,
  validateCycle
} from './Cycles'
import { BaseModel } from 'tydb'
import * as Logger from '../Logger'

// Socket modules
export let socketServer: SocketIO.Server
let ioclient: SocketIOClientStatic = require('socket.io-client')
let socketClient: SocketIOClientStatic["Socket"]

interface DataResponse<T extends ArchiversTypes.ValidTypes>{
  type: ArchiversTypes.TypeName<T>
  data: T[]
}

interface DataKeepAlive {
  keepAlive: boolean
}

//A collection of blobs that share the same cycle.  For TX summaries
type SummaryBlobCollection = {
  cycle:number; 
  blobsByPartition:Map<number, StateTypes.SummaryBlob>;
}

export interface ReceiptMapQueryResponse {
  success: boolean
  data: { [key: number]: StateTypes.ReceiptMapResult[]}
}
export interface SummaryBlobQueryResponse {
  success: boolean
  data: { [key: number]: StateTypes.SummaryBlob[]}
}
export interface StatsClumpQueryResponse {
  success: boolean
  data: { [key: number]: StateTypes.StatsClump[]}
}

export interface DataQueryResponse {
  success: boolean
  data: any
}

export let StateMetaDataMap = new Map()
export let currentDataSender: string = ''

export function initSocketServer(io: SocketIO.Server) {
  socketServer = io
  socketServer.on('connection', (socket: SocketIO.Socket) => {
    Logger.mainLogger.debug('Explorer has connected')
  })
}

export function unsubscribeDataSender() {
  Logger.mainLogger.debug('Disconnecting previous connection')
  socketClient.emit('UNSUBSCRIBE', config.ARCHIVER_PUBLIC_KEY);
  socketClient.disconnect()
  dataSenders.delete(currentDataSender)
  currentDataSender = ''
}

export function initSocketClient(node: NodeList.ConsensusNodeInfo) {
  Logger.mainLogger.debug(node)
  socketClient = ioclient.connect(`http://${node.ip}:${node.port}`)

  socketClient.on('connect', () => {
    Logger.mainLogger.debug('Connection to consensus node was made')
    // Send ehlo event right after connect:
    socketClient.emit('ARCHIVER_PUBLIC_KEY', config.ARCHIVER_PUBLIC_KEY);
  })


  socketClient.on('DATA', (newData: ArchiversTypes.DataResponse & Crypto.TaggedMessage ) => {
    if (!newData || !newData.responses) return
    if (newData.recipient !== State.getNodeInfo().publicKey) {
      Logger.mainLogger.debug('This data is not meant for this archiver')
      return
    }

    // If tag is invalid, dont keepAlive, END
    if (Crypto.authenticate(newData) === false) {
      Logger.mainLogger.debug('This data cannot be authenticated')
      unsubscribeDataSender()
      return
    }

    if(newData.responses.STATE_METADATA.length > 0) Logger.mainLogger.debug('New STATEMETADATA', newData.responses.STATE_METADATA[0])
    else Logger.mainLogger.debug('State metadata is empty')

    currentDataSender = newData.publicKey
    if (newData.responses && newData.responses.STATE_METADATA) {
      // Logger.mainLogger.debug('New DATA from consensor STATE_METADATA', newData.publicKey, newData.responses.STATE_METADATA)
      let hashArray: any = Gossip.convertStateMetadataToHashArray(newData.responses.STATE_METADATA[0])
      for (let stateMetadataHash of hashArray) {
        StateMetaDataMap.set(stateMetadataHash.counter, stateMetadataHash)
        Gossip.sendGossip('hashes', stateMetadataHash)
      }
    }
    
    const sender = dataSenders.get(newData.publicKey)
    // If publicKey is not in dataSenders, dont keepAlive, END
    if (!sender) {
      Logger.mainLogger.debug('NO SENDER')
      return
    }

    // If unexpected data type from sender, dont keepAlive, END
    const newDataTypes = Object.keys(newData.responses)
    for (const type of newDataTypes as (keyof typeof ArchiversTypes.TypeNames)[]) {
      if (sender.types.includes(type) === false) {
        Logger.mainLogger.debug(
          `NEW DATA type ${type} not included in sender's types: ${JSON.stringify(
            sender.types
          )}`
        )
        return
      }
    }
    setImmediate(processData, newData)
  })
}

export function createDataRequest<T extends ArchiversTypes.ValidTypes>(
  type: ArchiversTypes.TypeName<T>,
  lastData: ArchiversTypes.TypeIndex<T>,
  recipientPk: Crypto.types.publicKey
) {
  return Crypto.tag<ArchiversTypes.DataRequest<T>>(
    {
      type,
      lastData,
    },
    recipientPk
  )
}

export function createQueryRequest<T extends ArchiversTypes.ValidTypes>(
  type: string,
  lastData: number,
  recipientPk: Crypto.types.publicKey
) {
  return Crypto.tag(
    {
      type,
      lastData,
    },
    recipientPk
  )
}
// Vars to track Data senders

export interface DataSender {
  nodeInfo: NodeList.ConsensusNodeInfo
  types: (keyof typeof ArchiversTypes.TypeNames)[]
  contactTimeout?: NodeJS.Timeout | null
  replaceTimeout?: NodeJS.Timeout | null
}

export const dataSenders: Map<
  NodeList.ConsensusNodeInfo['publicKey'],
  DataSender
> = new Map()

const timeoutPadding = 1000

export const emitter = new EventEmitter()

export function replaceDataSender(publicKey: NodeList.ConsensusNodeInfo['publicKey']) {
  if (NodeList.getActiveList().length < 2) {
    Logger.mainLogger.debug('There is only one active node in the network. Unable to replace data sender')
    let sender = dataSenders.get(publicKey)
    if (sender && sender.replaceTimeout) {
      clearTimeout(sender.replaceTimeout)
      sender.replaceTimeout = null
      sender.replaceTimeout = createReplaceTimeout(publicKey)
    }
    return
  }
  Logger.mainLogger.debug(`replaceDataSender: replacing ${publicKey}`)

  // Remove old dataSender
  const removedSenders = removeDataSenders(publicKey)
  if (removedSenders.length < 1) {
    Logger.mainLogger.error('replaceDataSender failed: old sender not removed')
  }

  // Pick a new dataSender
  const newSenderInfo = selectNewDataSender()
  if (!newSenderInfo) {
    Logger.mainLogger.error('Unable to select a new data sender.')
    return
  }
  const newSender: DataSender = {
    nodeInfo: newSenderInfo,
    types: [ArchiversTypes.TypeNames.CYCLE, ArchiversTypes.TypeNames.STATE_METADATA],
    contactTimeout: createContactTimeout(newSenderInfo.publicKey, "This timeout is created during newSender selection", 2 * currentCycleDuration),
    replaceTimeout: createReplaceTimeout(newSenderInfo.publicKey),
  }

  // Add new dataSender to dataSenders
  addDataSenders(newSender)
  Logger.mainLogger.debug(
    `replaceDataSender: added new sender ${newSenderInfo.publicKey} to dataSenders`
  )

  // Send dataRequest to new dataSender
  const dataRequest = {
    dataRequestCycle: createDataRequest<Cycle>(
      ArchiversTypes.TypeNames.CYCLE,
      currentCycleCounter,
      publicKey
    ),
    dataRequestStateMetaData: createDataRequest<StateTypes.StateMetaData>(
      ArchiversTypes.TypeNames.STATE_METADATA,
      lastProcessedMetaData,
      publicKey
    )
  }
  sendDataRequest(newSender, dataRequest)
}

/**
 * Sets timeout to current cycle duration + some padding
 * Removes sender from dataSenders on timeout
 * Select a new dataSender
 */
export function createContactTimeout(
  publicKey: NodeList.ConsensusNodeInfo['publicKey'], msg: string = '', timeout: number | null = null
) {
  // TODO: check what is the best contact timeout
  let ms: number
  if (timeout) ms = timeout
  else if (currentCycleDuration > 0) ms = 1.5 * currentCycleDuration + timeoutPadding
  else ms = 1.5 * 30 * 1000 + timeoutPadding
  Logger.mainLogger.debug('Contact timeout:', ms)
  const contactTimeout = setTimeout(() => {
    Logger.mainLogger.debug('REPLACING sender due to CONTACT timeout', msg)
    replaceDataSender(publicKey)
  }, ms)
  return contactTimeout
}

export function createReplaceTimeout(
  publicKey: NodeList.ConsensusNodeInfo['publicKey']
) {
  const ms = config.DATASENDER_TIMEOUT || 1000 * 60 * 60
  const replaceTimeout = setTimeout(() => {
    Logger.mainLogger.debug('ROTATING sender due to ROTATION timeout')
    replaceDataSender(publicKey)
  }, ms)
  return replaceTimeout
}

export function addDataSenders(...senders: DataSender[]) {
  for (const sender of senders) {
    dataSenders.set(sender.nodeInfo.publicKey, sender)
    currentDataSender = sender.nodeInfo.publicKey
  }
}

function removeDataSenders (
  publicKey: NodeList.ConsensusNodeInfo['publicKey']
) {
  Logger.mainLogger.debug(`${new Date()}: Removing data sender ${publicKey}`)
  const removedSenders = []
  for (let [key, sender] of dataSenders) {
    if (sender) {
      // Clear contactTimeout associated with this sender
      if (sender.contactTimeout) {
        clearTimeout(sender.contactTimeout)
        sender.contactTimeout = null
      }
      if (sender.replaceTimeout) {
        clearTimeout(sender.replaceTimeout)
        sender.replaceTimeout = null
      }
  
      // Record which sender was removed
      removedSenders.push(sender)
  
      // Delete sender from dataSenders
      dataSenders.delete(key)
    }
  }

  return removedSenders
}

function selectNewDataSender() {
  // Randomly pick an active node
  const activeList = NodeList.getActiveList()
  const newSender = activeList[Math.floor(Math.random() * activeList.length)]
  Logger.mainLogger.debug('New data sender is selected', newSender)
  if(newSender) {
    unsubscribeDataSender()
    initSocketClient(newSender)
  }
  return newSender
}

export function sendDataRequest(
  sender: DataSender,
  dataRequest: any
) {
  const taggedDataRequest = Crypto.tag(dataRequest, sender.nodeInfo.publicKey)
  emitter.emit('selectNewDataSender', sender.nodeInfo, taggedDataRequest)
}

function calcIncomingTimes(record: Cycle) {
  const SECOND = 1000
  const cycleDuration = record.duration * SECOND
  const quarterDuration = cycleDuration / 4
  const start = record.start * SECOND + cycleDuration
  const startQ1 = start
  const startQ2 = start + 1 * quarterDuration
  const startQ3 = start + 2 * quarterDuration
  const startQ4 = start + 3 * quarterDuration
  const end = start + cycleDuration
  return { quarterDuration, startQ1, startQ2, startQ3, startQ4, end }
}

export async function joinNetwork (
  nodeList: NodeList.ConsensusNodeInfo[],
  isFirstTime: boolean
): Promise<boolean> {
  Logger.mainLogger.debug('Is firstTime', isFirstTime)
  if (isFirstTime === false) {
    const isJoined = await checkJoinStatus()
    if (isJoined) {
      return isJoined
    }
  }
  // try to get latestCycleRecord with a robust query
  const latestCycle = await getNewestCycleFromConsensors(nodeList)

  // Figure out when Q1 is from the latestCycle
  const { startQ1 } = calcIncomingTimes(latestCycle)
  let request = P2P.createArchiverJoinRequest()
  let shuffledNodes = [...nodeList]
  Utils.shuffleArray(shuffledNodes)

  // Wait until a Q1 then send join request to active nodes
  let untilQ1 = startQ1 - Date.now()
  while (untilQ1 < 0) {
    untilQ1 += latestCycle.duration * 1000
  }

  Logger.mainLogger.debug(`Waiting ${untilQ1 + 500} ms for Q1 before sending join...`)
  await Utils.sleep(untilQ1 + 500) // Not too early

  await submitJoin(nodeList, request)

  // Wait approx. one cycle then check again
  Logger.mainLogger.debug('Waiting approx. one cycle then checking again...')
  await Utils.sleep(latestCycle.duration * 1000 + 500)
  return false
}

export async function submitJoin(
  nodes: NodeList.ConsensusNodeInfo[],
  joinRequest: P2P.ArchiverJoinRequest & P2PTypes.SignedObject
) {
  // Send the join request to a handful of the active node all at once:w
  const selectedNodes = Utils.getRandom(nodes, Math.min(nodes.length, 5))
  Logger.mainLogger.debug(
    `Sending join request to ${selectedNodes.map((n) => `${n.ip}:${n.port}`)}`
  )
  for (const node of selectedNodes) {
    let response = await P2P.postJson(
      `http://${node.ip}:${node.port}/joinarchiver`,
      joinRequest
    )
    Logger.mainLogger.debug('Join request response:', response)
  }
}

export function sendLeaveRequest (
  nodeInfo: NodeList.ConsensusNodeInfo,
  cycle: Cycles.Cycle
) {

  let leaveRequest = P2P.createArchiverLeaveRequest()
  Logger.mainLogger.debug('Emitting submitLeaveRequest event')
  emitter.emit('submitLeaveRequest', nodeInfo, leaveRequest)
  return true
}


export async function getCycleDuration () {
  const randomArchiver = Utils.getRandomItemFromArr(State.activeArchivers)
  let response: any = await P2P.getJson(
    `http://${randomArchiver.ip}:${randomArchiver.port}/cycleinfo/1`)
  if (response && response.cycleInfo) {
    return response.cycleInfo[0].duration
  }
}

export async function getNewestCycleFromConsensors(activeNodes: NodeList.ConsensusNodeInfo[]): Promise<Cycle> {
  function isSameCyceInfo (info1: any, info2: any) {
    const cm1 = Utils.deepCopy(info1)
    const cm2 = Utils.deepCopy(info2)
    delete cm1.currentTime
    delete cm2.currentTime
    const equivalent = isDeepStrictEqual(cm1, cm2)
    return equivalent
  }

  const queryFn = async (node: any) => {
    const response: any = await P2P.getJson(
      `http://${node.ip}:${node.port}/sync-newest-cycle`
    )
    if(response.newestCycle) return response.newestCycle
  }
  let newestCycle: any = await P2PUtils.robustQuery(
    activeNodes,
    queryFn,
    isSameCyceInfo
  )
  return newestCycle[0]
}

export function checkJoinStatus (): Promise<boolean> {
  Logger.mainLogger.debug('Checking join status')
  const ourNodeInfo = State.getNodeInfo()
  const randomArchiver = Utils.getRandomItemFromArr(State.activeArchivers)

  return new Promise(async resolve => {
    let response: any = await P2P.getJson(
      `http://${randomArchiver.ip}:${randomArchiver.port}/cycleinfo/1`
    )
    try {
      if (
        response &&
        response.cycleInfo[0] &&
        response.cycleInfo[0].joinedArchivers
      ) {
        let joinedArchivers = response.cycleInfo[0].joinedArchivers
        let refreshedArchivers = response.cycleInfo[0].refreshedArchivers
        Logger.mainLogger.debug('cycle counter', response.cycleInfo[0].counter)
        Logger.mainLogger.debug('Joined archivers', joinedArchivers)

        let isJoind = [...joinedArchivers, ...refreshedArchivers].find(
          (a: any) => a.publicKey === ourNodeInfo.publicKey
        )
        Logger.mainLogger.debug('isJoind', isJoind)
        resolve(isJoind)
      } else {
        resolve(false)
      }
    } catch (e) {
      Logger.mainLogger.error(e)
      resolve(false)
    }
  })
}

async function sendDataQuery(
  consensorNode: NodeList.ConsensusNodeInfo,
  dataQuery: any,
  validateFn: any
) {
  const taggedDataQuery = Crypto.tag(dataQuery, consensorNode.publicKey)
  let result = await queryDataFromNode(consensorNode, taggedDataQuery, validateFn)
  return result
}

async function processData(newData: ArchiversTypes.DataResponse & Crypto.TaggedMessage) {
  // Get sender entry
  const sender = dataSenders.get(newData.publicKey)

  // If no sender entry, remove publicKey from senders, END
  if (!sender) {
    Logger.mainLogger.error('No sender found for this data')
    return
  }

  if (sender.nodeInfo.publicKey !== currentDataSender) {
    Logger.mainLogger.error(`Sender ${sender.nodeInfo.publicKey} is not current data sender.`)
  }

  // Clear senders contactTimeout, if it has one
  if (sender.contactTimeout) {
    clearTimeout(sender.contactTimeout)
    sender.contactTimeout = null
  }

  const newDataTypes = Object.keys(newData.responses)
  for (const type of newDataTypes as (keyof typeof ArchiversTypes.TypeNames)[]) {

    // Process data depending on type
    switch (type) {
      case ArchiversTypes.TypeNames.CYCLE: {
        Logger.mainLogger.debug('Processing CYCLE data')
        const cycle_data = newData.responses.CYCLE as Cycle[]
        processCycles(cycle_data)
        // socketServer.emit('ARCHIVED_CYCLE', 'CYCLE')
        if (cycle_data.length > 0) {
          for (let cycle of cycle_data) {
            if (!cycle.marker || typeof cycle.marker !== 'string') {
              Logger.mainLogger.error('Invalid Cycle Marker Received', cycle);
              return;
            }
            let archivedCycle: any = {}
            archivedCycle.cycleRecord = cycle
            archivedCycle.cycleMarker = cycle.marker
            Cycles.CycleChain.set(cycle.counter, cycle)
            await Storage.insertArchivedCycle(archivedCycle)
          }
        } else {
          Logger.mainLogger.error('Recieved empty cycle_data', newData.responses)
        }
        break
      }
      case ArchiversTypes.TypeNames.STATE_METADATA: {
        Logger.mainLogger.debug('Processing STATE_METADATA')
        const cycle_data = newData.responses.STATE_METADATA as StateTypes.StateMetaData[]
        processStateMetaData(cycle_data)
        break
      }
      default: {
        // If data type not recognized, remove sender from dataSenders
        Logger.mainLogger.error('Unknow data type detected', type)
        removeDataSenders(newData.publicKey)
      }
    }
  }

  // Set new contactTimeout for sender. Postpone sender removal because data is still received from consensor
  if (currentCycleDuration > 0) {
    sender.contactTimeout = createContactTimeout(sender.nodeInfo.publicKey, "This timeout is created after processing data")
  }
}

export async function processStateMetaData (STATE_METADATA: StateTypes.StateMetaData[]) {
  if (!STATE_METADATA) {
    Logger.mainLogger.error(
      'Invalid STATE_METADATA provided to processStateMetaData function',
      STATE_METADATA
    )
    return
  }
  for (let stateMetaData of STATE_METADATA) {
    let data, receipt, summary
    // [TODO] validate the state data by robust querying other nodes

    // store state hashes to archivedCycle
    stateMetaData.stateHashes.forEach(async (stateHashesForCycle: any) => {
      let parentCycle = Cycles.CycleChain.get(stateHashesForCycle.counter)
      if (!parentCycle) {
        Logger.mainLogger.error(
          'Unable to find parent cycle for cycle',
          stateHashesForCycle.counter
        )
        return
      }
      data = {
        parentCycle: parentCycle ? parentCycle.marker : '',
        networkHash: stateHashesForCycle.networkHash,
        partitionHashes: stateHashesForCycle.partitionHashes,
      }
      await Storage.updateArchivedCycle(data.parentCycle, 'data', data)
      Cycles.setLastProcessedMetaDataCounter(parentCycle.counter)
    })

    // store receipt hashes to archivedCycle
    stateMetaData.receiptHashes.forEach(async (receiptHashesForCycle: any) => {
      let parentCycle = Cycles.CycleChain.get(receiptHashesForCycle.counter)
      if (!parentCycle) {
        Logger.mainLogger.error(
          'Unable to find parent cycle for cycle',
          receiptHashesForCycle.counter
        )
        return
      }
      receipt = {
        parentCycle: parentCycle ? parentCycle.marker : '',
        networkHash: receiptHashesForCycle.networkReceiptHash,
        partitionHashes: receiptHashesForCycle.receiptMapHashes,
        partitionMaps: {},
        partitionTxs: {},
      }
      await Storage.updateArchivedCycle(receipt.parentCycle, 'receipt', receipt)
      Cycles.setLastProcessedMetaDataCounter(parentCycle.counter)

      // Query receipt maps from other nodes and store it
      if (receiptHashesForCycle.receiptMapHashes) {
        let isDownloadSuccess = false
        let retry = 0
        let sleepCount = 0
        let failedPartitions = new Map()
        let coveredPartitions = new Map()
        let downloadedReceiptMaps = new Map()

        let shouldProcessBlob = (partition: number) => {
          if (failedPartitions.has(partition) || !coveredPartitions.has(partition)) return true
          return false
        }

        while(!isDownloadSuccess && sleepCount < 20) {
          let randomConsensor = NodeList.getRandomActiveNode()
          const queryRequest = createQueryRequest(
            'RECEIPT_MAP',
            receiptHashesForCycle.counter - 1,
            randomConsensor.publicKey
          )
          let { success, completed, failed, covered, blobs } = await sendDataQuery(randomConsensor, queryRequest, shouldProcessBlob)
          for (let partition of failed) {
            failedPartitions.set(partition, true)
          }
          for (let partition of completed) {
            if(failedPartitions.has(partition)) failedPartitions.delete(partition)
          }
          for (let partition of covered) {
            coveredPartitions.set(partition, true)
          }
          for (let partition in blobs) {
            downloadedReceiptMaps.set(partition, blobs[partition])
          }
          isDownloadSuccess = failedPartitions.size === 0 && coveredPartitions.size === NodeList.getActiveList().length
          if (isDownloadSuccess) {
            Logger.mainLogger.debug('Data query for receipt map is completed')
            Logger.mainLogger.debug('Total downloaded receipts', downloadedReceiptMaps.size)
            let receiptMapsToForward = []
            for (let [partition, receiptMap] of downloadedReceiptMaps) {
              receiptMapsToForward.push(receiptMap)
            }
            receiptMapsToForward = receiptMapsToForward.filter(receipt => receipt.cycle === parentCycle.counter)
            Logger.mainLogger.debug('receiptMapsToForward', receiptMapsToForward.length)
            // socketServer.emit('RECEIPT_MAP', receiptMapsToForward)
            break
          }
          retry += 1
          if (!isDownloadSuccess && retry >= NodeList.getActiveList().length) {
            Logger.mainLogger.debug('Sleeping for 5 sec before retrying download again for cycle', parentCycle.counter)
            await Utils.sleep(5000)
            retry = 0
            sleepCount += 1
          }
        }
        if (!isDownloadSuccess) {
          Logger.mainLogger.debug(`Downloading receipt map for cycle ${parentCycle.counter} has failed.`)
        }
      }  
    })

    // store summary hashes to archivedCycle
    stateMetaData.summaryHashes.forEach(async (summaryHashesForCycle: any) => {
      let parentCycle = Cycles.CycleChain.get(summaryHashesForCycle.counter)
      if (!parentCycle) {
        Logger.mainLogger.error(
          'Unable to find parent cycle for cycle',
          summaryHashesForCycle.counter
        )
        return
      }
      summary = {
        parentCycle: parentCycle ? parentCycle.marker : '',
        networkHash: summaryHashesForCycle.networkSummaryHash,
        partitionHashes: summaryHashesForCycle.summaryHashes,
        partitionBlobs: {},
      }
      await Storage.updateArchivedCycle(summary.parentCycle, 'summary', summary)
      Cycles.setLastProcessedMetaDataCounter(parentCycle.counter)

      // Query summary blobs from other nodes and store it
      if (summaryHashesForCycle.summaryHashes) {
        let isDownloadSuccess = false
        let retry = 0
        let sleepCount = 0
        let failedPartitions = new Map()
        let coveredPartitions = new Map()
        let downloadedBlobs = new Map()

        let shouldProcessBlob = (partition: number) => {
          if (failedPartitions.has(partition) || !coveredPartitions.has(partition)) return true
          return false
        }

        while(!isDownloadSuccess && sleepCount < 20) {
          let randomConsensor = NodeList.getRandomActiveNode()
          const queryRequest = createQueryRequest(
            'SUMMARY_BLOB',
            summaryHashesForCycle.counter - 1,
            randomConsensor.publicKey
          )
          let { success, completed, failed, covered, blobs } = await sendDataQuery(randomConsensor, queryRequest, shouldProcessBlob)
          for (let partition of failed) {
            failedPartitions.set(partition, true)
          }
          for (let partition of completed) {
            if(failedPartitions.has(partition)) failedPartitions.delete(partition)
          }
          for (let partition of covered) {
            coveredPartitions.set(partition, true)
          }
          for (let partition in blobs) {
            downloadedBlobs.set(partition, blobs[partition])
          }
          isDownloadSuccess = failedPartitions.size === 0 && coveredPartitions.size === 32
          if (isDownloadSuccess) {
            Logger.mainLogger.debug('Data query for summary blob is completed')
            Logger.mainLogger.debug('Total downloaded blobs', downloadedBlobs.size)
            let blobsToForward = []
            for (let [partition, blob] of downloadedBlobs) {
              blobsToForward.push(blob)
            }
            break
          }

          retry += 1
          if (!isDownloadSuccess && retry >= NodeList.getActiveList().length) {
            Logger.mainLogger.debug('Sleeping for 5 sec before retrying download again for cycle', parentCycle.counter)
            await Utils.sleep(5000)
            retry = 0
            sleepCount += 1
          }
        }
        if (!isDownloadSuccess) {
          Logger.mainLogger.debug(`Downloading summary blob for cycle ${parentCycle.counter} has failed.`)
        }
      }      
    })
  }
}


export async function fetchStateHashes (archivers: any) {
  function _isSameStateHashes (info1: any, info2: any ) {
    const cm1 = Utils.deepCopy(info1)
    const cm2 = Utils.deepCopy(info2)
    delete cm1.currentTime
    delete cm2.currentTime
    const equivalent = isDeepStrictEqual(cm1, cm2)
    return equivalent
  }

  const queryFn = async (node: any) => {
    const response: any = await P2P.getJson(
      `http://${node.ip}:${node.port}/statehashes`
    )
    return response.stateHashes
  }
  const stateHashes:any = await P2PUtils.robustQuery(
    archivers,
    queryFn,
    _isSameStateHashes
  )
  return stateHashes[0]
}

export async function fetchCycleRecords(activeArchivers: State.ArchiverNodeInfo[], start:number, end: number): Promise<any> {
  function isSameCyceInfo (info1: any, info2: any) {
    const cm1 = Utils.deepCopy(info1)
    const cm2 = Utils.deepCopy(info2)
    delete cm1.currentTime
    delete cm2.currentTime
    const equivalent = isDeepStrictEqual(cm1, cm2)
    return equivalent
  }

  const queryFn = async (node: any) => {
    const response: any = await P2P.getJson(
      `http://${node.ip}:${node.port}/cycleinfo?start=${start}&end=${end}`
    )
    return response.cycleInfo
  }
  const { result } = await P2PUtils.sequentialQuery(activeArchivers, queryFn)
  return result
}

export async function getNewestCycleFromArchivers(activeArchivers: State.ArchiverNodeInfo[]): Promise<any> {
  function isSameCyceInfo (info1: any, info2: any) {
    const cm1 = Utils.deepCopy(info1)
    const cm2 = Utils.deepCopy(info2)
    delete cm1.currentTime
    delete cm2.currentTime
    const equivalent = isDeepStrictEqual(cm1, cm2)
    return equivalent
  }

  const queryFn = async (node: any) => {
    const response: any = await P2P.getJson(
      `http://${node.ip}:${node.port}/cycleinfo/1`
    )
    return response.cycleInfo
  }
  let cycleInfo: any = await P2PUtils.robustQuery(
    activeArchivers,
    queryFn,
    isSameCyceInfo
  )
  return cycleInfo[0]
}

export function parseRecord (record: any): Changer.Change {
  // For all nodes described by activated, make an update to change their status to active
  const activated = record.activated.map((id: string) => ({
    id,
    activeTimestamp: record.start,
    status: P2PTypes.NodeStatus.ACTIVE,
  }))

  const refreshAdded: Changer.Change['added'] = []
  const refreshUpdated: Changer.Change['updated'] = []
  for (const refreshed of record.refreshedConsensors) {
    // const node = NodeList.nodes.get(refreshed.id)
    const node = NodeList.getNodeInfoById(refreshed.id) as NodeList.JoinedConsensor
    if (node) {
      // If it's in our node list, we update its counterRefreshed
      // (IMPORTANT: update counterRefreshed only if its greater than ours)
      if (record.counter > node.counterRefreshed) {
        refreshUpdated.push({
          id: refreshed.id,
          counterRefreshed: record.counter,
        })
      }
    } else {
      // If it's not in our node list, we add it...
      refreshAdded.push(refreshed)
      // and immediately update its status to ACTIVE
      // (IMPORTANT: update counterRefreshed to the records counter)
      refreshUpdated.push({
        id: refreshed.id,
        status: P2PTypes.NodeStatus.ACTIVE,
        counterRefreshed: record.counter,
      })
    }
  }

  return {
    added: [...record.joinedConsensors],
    removed: [...record.apoptosized],
    updated: [...activated, refreshUpdated],
  }
}

export function parse (record: any): Changer.Change {
  const changes = parseRecord(record)
  // const mergedChange = deepmerge.all<Changer.Change>(changes)
  // return mergedChange
  return changes
}

function applyNodeListChange(change: Changer.Change) {
  if (change.added.length > 0) {
    const consensorInfos = change.added.map((jc: any) => ({
      ip: jc.externalIp,
      port: jc.externalPort,
      publicKey: jc.publicKey,
      id: jc.id,
    }))

    NodeList.addNodes(P2PTypes.NodeStatus.ACTIVE, change.added[0].cycleJoined, consensorInfos)
  }
  if (change.removed.length > 0) {
    NodeList.removeNodes(change.removed)
  }
}

export async function syncCyclesAndNodeList (activeArchivers: State.ArchiverNodeInfo[]) {
  // Get the networks newest cycle as the anchor point for sync
  Logger.mainLogger.debug('Getting newest cycle...')
  const [cycleToSyncTo] = await getNewestCycleFromArchivers(activeArchivers)
  Logger.mainLogger.debug('cycleToSyncTo', cycleToSyncTo)
  Logger.mainLogger.debug(`Syncing till cycle ${cycleToSyncTo.counter}...`)
  const cyclesToGet = 2 * Math.floor(Math.sqrt(cycleToSyncTo.active)) + 2
  Logger.mainLogger.debug(`Cycles to get is ${cyclesToGet}`)

  let CycleChain = []
  const squasher = new Changer.ChangeSquasher()

  CycleChain.unshift(cycleToSyncTo)
  squasher.addChange(parse(CycleChain[0]))

  do {
    // Get prevCycles from the network
    let end: number = CycleChain[0].counter - 1
    let start: number = end - cyclesToGet
    if (start < 0) start = 0
    if (end < start) end = start
    Logger.mainLogger.debug(`Getting cycles ${start} - ${end}...`)
    const prevCycles = await fetchCycleRecords(activeArchivers, start, end)

    // If prevCycles is empty, start over
    if (prevCycles.length < 1) throw new Error('Got empty previous cycles')

    // Add prevCycles to our cycle chain
    let prepended = 0
    for (const prevCycle of prevCycles) {
      // Stop prepending prevCycles if one of them is invalid
      if (validateCycle(prevCycle, CycleChain[0]) === false) {
        Logger.mainLogger.error(`Record ${prevCycle.counter} failed validation`)
        break
      }
      // Prepend the cycle to our cycle chain
      CycleChain.unshift(prevCycle)
      squasher.addChange(parse(prevCycle))
      prepended++

      if (
        squasher.final.updated.length >= SyncUtils.activeNodeCount(cycleToSyncTo) &&
        squasher.final.added.length >= SyncUtils.totalNodeCount(cycleToSyncTo)
      ) {
        break
      }
    }

    Logger.mainLogger.debug(
      `Got ${
        squasher.final.updated.length
      } active nodes, need ${SyncUtils.activeNodeCount(cycleToSyncTo)}`
    )
    Logger.mainLogger.debug(
      `Got ${squasher.final.added.length} total nodes, need ${SyncUtils.totalNodeCount(
        cycleToSyncTo
      )}`
    )
    if (squasher.final.added.length < SyncUtils.totalNodeCount(cycleToSyncTo))
      Logger.mainLogger.debug(
        'Short on nodes. Need to get more cycles. Cycle:' +
          cycleToSyncTo.counter
      )

    // If you weren't able to prepend any of the prevCycles, start over
    if (prepended < 1) throw new Error('Unable to prepend any previous cycles')
  } while (
    squasher.final.updated.length < SyncUtils.activeNodeCount(cycleToSyncTo) ||
    squasher.final.added.length < SyncUtils.totalNodeCount(cycleToSyncTo)
  )

  applyNodeListChange(squasher.final)
  Logger.mainLogger.debug('NodeList after sync', NodeList.getActiveList())

  for (let i = 0; i < CycleChain.length; i++) {
    let record = CycleChain[i]
    Logger.mainLogger.debug('Inserting archived cycle for counter', record.counter)
    Cycles.CycleChain.set(record.counter, {...record})
    const archivedCycle = createArchivedCycle(record)
    await Storage.insertArchivedCycle(archivedCycle)
    Cycles.setCurrentCycleCounter(record.counter)
  }
  Logger.mainLogger.debug('Cycle chain is synced. Size of CycleChain', Cycles.CycleChain.size)
  return true
}

function createArchivedCycle(cycleRecord: Cycle) {
  let archivedCycle: any = {
    cycleRecord: cycleRecord,
    cycleMarker: cycleRecord.marker,
    data: {},
    receipt: {},
    summary: {}
  }
  return archivedCycle
}

async function downloadArchivedCycles(archiver: State.ArchiverNodeInfo, cycleToSyncTo: number, startCycle: number = 0) {
  let complete = false
  let lastData = startCycle
  let collector: any = []
  let count = 0
  let maxCount = Math.ceil((cycleToSyncTo - startCycle) / 5)
  while (!complete && count < maxCount) {
    Logger.mainLogger.debug(`Downloading archive from cycle ${lastData} to cycle ${lastData + 5}`)
    let response: any = await P2P.getJson(
      `http://${archiver.ip}:${archiver.port}/full-archive?start=${lastData}&end=${lastData + 5}`)
    if (response && response.archivedCycles) {
      collector = collector.concat(response.archivedCycles)
      if (response.archivedCycles.length < 5) {
        complete = true
        Logger.mainLogger.debug('Download completed')
      }
    } else {
      Logger.mainLogger.debug('Invalid download response')
    }
    count += 1
    lastData += 5
  }
  Logger.mainLogger.debug(`Downloaded archived cycles`, collector.length)
  return collector
}

export async function syncStateMetaData (activeArchivers: State.ArchiverNodeInfo[]) {
  const randomArchiver = Utils.getRandomItemFromArr(activeArchivers)
  let allCycleRecords = await Storage.queryAllCycleRecords()
  let lastCycleCounter = allCycleRecords[0].counter
  let downloadedArchivedCycles = await downloadArchivedCycles(randomArchiver, lastCycleCounter)

  let networkReceiptHashesFromRecords = new Map()
  let networkDataHashesFromRecords = new Map()
  let networkSummaryHashesFromRecords = new Map()

  allCycleRecords.forEach((cycleRecord: any) => {
    if (cycleRecord.networkReceiptHash.length > 0) {
      cycleRecord.networkReceiptHash.forEach((hash: any) => {
        networkReceiptHashesFromRecords.set(hash.cycle, hash.hash)
      })
    }
    if (cycleRecord.networkDataHash.length > 0) {
      cycleRecord.networkDataHash.forEach((hash: any) => {
        networkDataHashesFromRecords.set(hash.cycle, hash.hash)
      })
    }
    if (cycleRecord.networkSummaryHash.length > 0) {
      cycleRecord.networkSummaryHash.forEach((hash: any) => {
        networkSummaryHashesFromRecords.set(hash.cycle, hash.hash)
      })
    }
  })

  for (let i = 0; i < downloadedArchivedCycles.length; i++) {
    let marker = downloadedArchivedCycles[i].cycleRecord.marker
    let counter = downloadedArchivedCycles[i].cycleRecord.counter
    let downloadedArchivedCycle = downloadedArchivedCycles[i]

    if (!downloadedArchivedCycle) {
      Logger.mainLogger.debug('Unable to download archivedCycle for counter', counter)
      continue
    }

    let isDataSynced = false
    let isReceiptSynced = false
    let isSummarySynced = false
  
    // Check and store data hashes
    if (downloadedArchivedCycle.data) {
      let downloadedNetworkDataHash = downloadedArchivedCycle.data.networkHash
      if (downloadedNetworkDataHash === networkDataHashesFromRecords.get(counter)) {
        await Storage.updateArchivedCycle(marker, 'data', downloadedArchivedCycle.data)
        isDataSynced = true
      } else {
        Logger.mainLogger.error('different network data hash  for cycle', counter)
      }
    } else {
      Logger.mainLogger.error(`ArchivedCycle ${downloadedArchivedCycle.cycleRecord.counter}, ${downloadedArchivedCycle.cycleMarker} does not have data field`)
    }

    // Check and store receipt hashes + receiptMap
    if (downloadedArchivedCycle.receipt) {
      // TODO: calcuate the network hash by hashing downloaded receipt Map instead of using downloadedNetworkReceiptHash
      let downloadedNetworkReceiptHash = downloadedArchivedCycle.receipt.networkHash
      let actualHash = Crypto.hashObj(downloadedArchivedCycle.receipt.partitionHashes)
      console.log("actualHash", actualHash)
      console.log("networkReceiptHashesFromRecords", networkReceiptHashesFromRecords.get(counter))
      if (downloadedNetworkReceiptHash === networkReceiptHashesFromRecords.get(counter)) {
        await Storage.updateArchivedCycle(marker, 'receipt', downloadedArchivedCycle.receipt)
        isReceiptSynced = true
      }
    } else {
      Logger.mainLogger.error(`ArchivedCycle ${downloadedArchivedCycle.cycleRecord.counter}, ${downloadedArchivedCycle.cycleMarker} does not have receipt field`)
    }

    // Check and store summary hashes
    if (downloadedArchivedCycle.summary) {
      // TODO: calcuate the network hash by hashing downloaded summary Blobs instead of using downloadedNetworkSummaryHash
      let downloadedNetworkSummaryHash = downloadedArchivedCycle.summary.networkHash
      if (downloadedNetworkSummaryHash === networkSummaryHashesFromRecords.get(counter)) {
        await Storage.updateArchivedCycle(marker, 'summary', downloadedArchivedCycle.summary)
        isSummarySynced = true
      }
    } else {
      Logger.mainLogger.error(`ArchivedCycle ${downloadedArchivedCycle.cycleRecord.counter}, ${downloadedArchivedCycle.cycleMarker} does not have summary field`)
    }
    if (isDataSynced && isReceiptSynced && isSummarySynced) {
      Logger.mainLogger.debug(`Successfully synced statemetadata for counter ${counter}`)
      if(counter > Cycles.lastProcessedMetaData) {
        Cycles.setLastProcessedMetaDataCounter(counter)
        return true
      }
    }
  }
  return false
}

export type QueryDataResponse = ReceiptMapQueryResponse | StatsClumpQueryResponse

async function queryDataFromNode (
  consensorNode: NodeList.ConsensusNodeInfo,
  dataQuery: any,
  validateFn: any
) {
  let request = {
    ...dataQuery,
    nodeInfo: State.getNodeInfo(),
  }
  let result: any = { success: false, completed: []}
  try {
    let response = await P2P.postJson(
      `http://${consensorNode.ip}:${consensorNode.port}/querydata`,
      request
    ) as QueryDataResponse
    if (response && request.type === 'RECEIPT_MAP') {
      let receiptMapData = response.data as ReceiptMapQueryResponse['data']
      for (let counter in response.data) {
        result = await validateAndStoreReceiptMaps(receiptMapData, validateFn)
      }
    } else if (response && request.type === 'SUMMARY_BLOB') {
      for (let counter in response.data) {
        result = await validateAndStoreSummaryBlobs(Object.values(response.data), validateFn)
      }
    }
    return result
  } catch(e) {
    Logger.mainLogger.error(e)
    Logger.mainLogger.error(`Unable to query complete querying ${request.type} from node`, consensorNode)
    return result
  }
}

async function validateAndStoreReceiptMaps (receiptMapResultsForCycles: {
  [key: number]: StateTypes.ReceiptMapResult[]
}, validateFn: any) {
  let completed: number[] = []
  let failed: number[] = []
  let coveredPartitions: number[] = []
  let receiptMaps: any = {}
  for (let counter in receiptMapResultsForCycles) {
    let receiptMapResults: StateTypes.ReceiptMapResult[] =
      receiptMapResultsForCycles[counter]
    for (let partitionBlock of receiptMapResults) {
      let { partition } = partitionBlock
      if (validateFn) {
        let shouldProcess = validateFn(partition)
        if (!shouldProcess) {
          continue
        }
      }
      coveredPartitions.push(partition)
      let reciptMapHash = await Storage.queryReceiptMapHash(parseInt(counter), partition)
      if (!reciptMapHash) {
        Logger.mainLogger.error(`Unable to find receipt hash for counter ${counter}, partition ${partition}`)
        continue
      }
      let calculatedReceiptMapHash = Crypto.hashObj(partitionBlock)
      if (calculatedReceiptMapHash === reciptMapHash) {
        await Storage.updateReceiptMap(partitionBlock)
        completed.push(partition)
        receiptMaps[partition] = partitionBlock
      } else {
        Logger.mainLogger.error('Different hash while downloading receipt maps')
        failed.push(partition)
      }
    }
  }
  return {
    success: true,
    completed,
    failed,
    covered: coveredPartitions,
    blobs: receiptMaps
  }
}

async function validateAndStoreSummaryBlobs (
  statsClumpForCycles: StateTypes.StatsClump[],
  validateFn: any
) {
  let completed: number[] = []
  let failed: number[] = []
  let coveredPartitions: number[] = []
  let blobs: any = {}

  for (let statsClump of statsClumpForCycles) {
    let { cycle, dataStats, txStats, covered } = statsClump
    for (let partition of covered) {
      if (validateFn) {
        let shouldProcess = validateFn(partition)
        if (!shouldProcess) {
          continue
        }
      }
      coveredPartitions.push(partition)
      let summaryBlob
      let dataBlob = dataStats.find(d => d.partition === partition)
      let txBlob = txStats.find(t => t.partition === partition)
      let summaryHash = await Storage.querySummaryHash(cycle, partition)
      if (!summaryHash) {
        continue
      }
      let summaryObj = {
        dataStats: dataBlob ? dataBlob.opaqueBlob : {},
        txStats: txBlob ? txBlob.opaqueBlob : {},
      }
      let calculatedSummaryHash = Crypto.hashObj(summaryObj)
      if (summaryHash !== calculatedSummaryHash) {
        failed.push(partition)
        continue
      }
      if (dataBlob) {
        summaryBlob = {
          ...dataBlob,
        }
      }
      if (txBlob) {
        if (!summaryBlob) {
          summaryBlob = {
            ...txBlob
          }
        } else if (summaryBlob) {
          summaryBlob.latestCycle = txBlob.latestCycle
          summaryBlob.opaqueBlob = {
            ...summaryBlob.opaqueBlob,
            ...txBlob.opaqueBlob,
          }
        }
      }
      if (summaryBlob) { 
        try {
          await Storage.updateSummaryBlob(summaryBlob, cycle)
          completed.push(partition)
          blobs[partition] = summaryBlob
        } catch (e) {
          Logger.mainLogger.error('Unable to store summary blob', e)
          throw new Error('Unable to store summary blob')
        }
      }
    }
  }
  return {
    success: true,
    completed,
    failed,
    covered: coveredPartitions,
    blobs
  }
}

emitter.on(
  'selectNewDataSender',
  async (
    newSenderInfo: NodeList.ConsensusNodeInfo,
    dataRequest: any
  ) => {
    let request = {
      ...dataRequest,
      nodeInfo: State.getNodeInfo()
    }
    let response = await P2P.postJson(
      `http://${newSenderInfo.ip}:${newSenderInfo.port}/requestdata`,
      request
    )
  }
)

emitter.on(
  'submitJoinRequest',
  async (
    newSenderInfo: NodeList.ConsensusNodeInfo,
    joinRequest: any
  ) => {
    let request = {
      ...joinRequest,
      nodeInfo: State.getNodeInfo()
    }
    let response = await P2P.postJson(
      `http://${newSenderInfo.ip}:${newSenderInfo.port}/joinarchiver`,
      request
    )
    Logger.mainLogger.debug('Join request response:', response)
  }
)

emitter.on(
  'submitLeaveRequest',
  async (
    consensorInfo: NodeList.ConsensusNodeInfo,
    leaveRequest: any
  ) => {
    let request = {
      ...leaveRequest,
      nodeInfo: State.getNodeInfo()
    }
    Logger.mainLogger.debug('Sending leave request to: ', consensorInfo.port)
    let response = await P2P.postJson(
      `http://${consensorInfo.ip}:${consensorInfo.port}/leavingarchivers`,
      request
    )
    Logger.mainLogger.debug('Leave request response:', response)
  }
)
