import fastify = require('fastify')
import * as Crypto from '../Crypto'
import * as Data from './Data'
import * as State from '../State'
import * as P2P from '../P2P'
import { config, Config } from '../Config'
import * as Logger from '../Logger'
import { P2P as P2PTypes} from 'shardus-types'
import { profilerInstance, nestedCountersInstance, memoryReportingInstance} from '../server'

let gossipCollector = new Map()
let processedCounters = new Map()

export async function sendGossip (type: string, payload: any) {
  let archivers: State.ArchiverNodeInfo[] = [...State.activeArchivers]

  if (archivers.length === 0) return
  const gossipPayload = { type, data: payload, sender: config.ARCHIVER_PUBLIC_KEY }

  archivers = archivers.sort((a: any, b: any) => a.publicKey - b.publicKey)

  // TODO: check if need to select random archivers instead of sending to all other archivers
  let recipients: State.ArchiverNodeInfo[] = archivers.filter(
    a => a.publicKey !== config.ARCHIVER_PUBLIC_KEY
  )

  if (recipients.length === 0) {
    Logger.mainLogger.debug('There is no other archivers to send our gossip')
    return
  }

  try {
    Logger.mainLogger.debug(
      `GossipingIn ${type} request to these nodes: ${JSON.stringify(
        recipients.map(node => node.ip + ':' + node.port + `/gossip-${type}`)
      )}`
    )
    await tell(recipients, `gossip-${type}`, gossipPayload, true)
  } catch (ex) {
    Logger.mainLogger.debug(ex)
    Logger.mainLogger.debug('Fail to gossip')
  }
}

async function tell (
  nodes: State.ArchiverNodeInfo[],
  route: string,
  message: any,
  logged = false
) {
  let InternalTellCounter = 0
  const promises = []
  for (const node of nodes) {
    InternalTellCounter++
    const url = `http://${node.ip}:${node.port}/${route}`
    try {
      const promise = P2P.postJson(url, message)
      promise.catch(err => {
        Logger.mainLogger.error(`Unable to tell node ${node.ip}: ${node.port}`, err)
      })
      promises.push(promise)
    } catch(e) {
      Logger.mainLogger.error('Error', e)
    }
  }
  try {
    await Promise.all(promises)
  } catch (err) {
    Logger.mainLogger.error('Network: ' + err)
  }
}

export function convertStateMetadataToHashArray(STATE_METATDATA: any) {
  let hashCollector: any = {}
  STATE_METATDATA.stateHashes.forEach((h:any) => {
    if (!hashCollector[h.counter]) {
      hashCollector[h.counter] = {
        counter: h.counter
      }
    }
    hashCollector[h.counter]['stateHashes'] = h
  })
  STATE_METATDATA.receiptHashes.forEach((h:any) => {
    if (!hashCollector[h.counter]) {
      hashCollector[h.counter] = {
        counter: h.counter
      }
    }
    hashCollector[h.counter]['receiptHashes'] = h
  })
  STATE_METATDATA.summaryHashes.forEach((h:any) => {
    if (!hashCollector[h.counter]) {
      hashCollector[h.counter] = {
        counter: h.counter
      }
    }
    hashCollector[h.counter]['summaryHashes'] = h
  })
  return Object.values(hashCollector)
}

export function addHashesGossip (
  sender: string,
  gossip: any
) {
  let counter = gossip.counter
  if (gossipCollector.has(counter)) {
    let existingGossips = gossipCollector.get(counter)
    existingGossips[sender] = gossip
  } else {
    let obj: any = {}
    obj[sender] = gossip
    gossipCollector.set(counter, obj)
  }
  let totalGossip = gossipCollector.get(counter)
  if (
    totalGossip &&
    Object.keys(totalGossip).length > 0.3 * State.activeArchivers.length
  ) {
    setTimeout(() => {
      processGossip(counter)
      gossipCollector.delete(counter)
    }, 500)
  }
}

function processGossip(counter: number) {
    if (processedCounters.has(counter)) {
        Logger.mainLogger.info('We have already processed gossip for this counter', counter)
        return
    }
    profilerInstance.profileSectionStart('process_gossip')
    try {
        Logger.mainLogger.debug('Processing gossips for counter', counter, gossipCollector.get(counter))
        let gossips = gossipCollector.get(counter)
        if (!gossips) {
            return
        }
        let ourHashes = Data.StateMetaDataMap.get(counter)
        let gossipCounter: any = {}
        for (let sender in gossips) {
            let hashedGossip = Crypto.hashObj(gossips[sender])
            if(!gossipCounter[hashedGossip]) {
                gossipCounter[hashedGossip] = {
                    count: 1,
                    gossip: gossips[sender]
                }
                // To count our StateMetaData also
                if (hashedGossip === Crypto.hashObj(ourHashes)) {
                    gossipCounter[hashedGossip].count += 1
                }
            } else {
                gossipCounter[hashedGossip].count += 1
            }
        }
        let gossipWithHighestCount: P2PTypes.SnapshotTypes.StateMetaData[] = []
        let highestCount = 0
        let hashWithHighestCounter: any
        for (let key in gossipCounter) {
            if (gossipCounter[key].count > highestCount) {
                gossipWithHighestCount.push(gossipCounter[key].gossip)
                hashWithHighestCounter = key
                highestCount = gossipCounter[key].count
            }
        }
        Logger.mainLogger.debug('Gossip with highest count:', JSON.stringify(gossipWithHighestCount))

        if (!ourHashes) {
            Logger.mainLogger.error(`Unable to find our stored statemetadata hashes for counter ${counter}`)
            return
        }
        if (hashWithHighestCounter && hashWithHighestCounter !== Crypto.hashObj(ourHashes)) {
            if (gossipWithHighestCount.length === 0) {
                Logger.mainLogger.error('Unable to find gossip with highest count.')
                return
            }
            nestedCountersInstance.countEvent('archiver', 'different_archiver_hashes')
            Logger.mainLogger.error('our hash is different from other archivers hashes. Storing the correct hashes')
            Data.processStateMetaData(gossipWithHighestCount)
            Data.replaceDataSender(Data.currentDataSender)
        } else {
            nestedCountersInstance.countEvent('archiver', 'same_archiver_hashes')
            Logger.mainLogger.info(`Our hash and other archivers' hashes are the same. No need to change data sender.`)
        }
    } finally {
        processedCounters.set(counter, true)
        profilerInstance.profileSectionEnd('process_gossip')
    }
}
