const _startingMessage = `@shardus/archiver starting at
  locale:  ${new Date().toLocaleString()}
  ISO/UTC: ${new Date().toISOString()}`
console.log(_startingMessage)
console.error(_startingMessage)

import { join } from 'path'
import { Server } from './http/Server'
import { overrideDefaultConfig, config } from './Config'
import * as Crypto from './Crypto'
import * as State from './State'
import * as NodeList from './NodeList'
import * as P2P from './P2P'
import * as Storage from './archivedCycle/Storage'
import * as Data from './Data/Data'
import * as Cycles from './Data/Cycles'
import { initDataLogWriter } from './Data/DataLogWriter'
import * as Utils from './Utils'
import { addHashesGossip } from './archivedCycle/Gossip'
import { syncStateMetaData } from './archivedCycle/StateMetaData'
import * as Logger from './Logger'
import { P2P as P2PTypes } from '@shardus/types'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Readable } from 'stream'
import MemoryReporting, {
  memoryReportingInstance,
  setMemoryReportingInstance,
} from './profiler/memoryReporting'
import NestedCounters, { nestedCountersInstance, setNestedCountersInstance } from './profiler/nestedCounters'
import Profiler, { profilerInstance, setProfilerInstance } from './profiler/profiler'
import Statistics from './statistics'
import * as dbstore from './dbstore'
import * as CycleDB from './dbstore/cycles'
import * as AccountDB from './dbstore/accounts'
import * as TransactionDB from './dbstore/transactions'
import * as ReceiptDB from './dbstore/receipts'
import * as OriginalTxDB from './dbstore/originalTxsData'
import { startSaving } from './saveConsoleOutput'
import { setupArchiverDiscovery } from '@shardus/archiver-discovery'
import * as Collector from './Data/Collector'
import * as GossipData from './Data/GossipData'
import * as AccountDataProvider from './Data/AccountDataProvider'
const { version } = require('../package.json') // eslint-disable-line @typescript-eslint/no-var-requires
import { getGlobalNetworkAccount, loadGlobalAccounts, syncGlobalAccount } from './GlobalAccount'
import { setShutdownCycleRecord, cycleRecordWithShutDownMode } from './Data/Cycles'
import * as path from 'path'
import * as fs from 'fs'
import {
  Middleware,
  corsMiddleware,
  getBodyMiddleware,
  getQueryStringMiddleware,
  rateLimitMiddleware,
} from './http/Middleware'

// Socket modules
let io: SocketIO.Server

// Types
export type ReceiptQuery = {
  start: string
  end: string
  startCycle: string
  endCycle: string
  type: string
  page: string
  txId: string
  txIdList: string
}

export type AccountQuery = {
  start: string
  end: string
  startCycle: string
  endCycle: string
  type: string
  page: string
  accountId: string
}

export type TransactionQuery = {
  start: string
  end: string
  startCycle: string
  endCycle: string
  txId: string
  page: string
  accountId: string
}

export type FullArchiveQuery = {
  start: string
  end: string
}

// Override default config params from config file, env vars, and cli args
// commented out since never used
// const file = join(process.cwd(), 'archiver-config.json')
const env = process.env
const args = process.argv
let logDir: string

const TXID_LENGTH = 64
export const MAX_ACCOUNTS_PER_REQUEST = 1000
export const MAX_RECEIPTS_PER_REQUEST = 1000
export const MAX_ORIGINAL_TXS_PER_REQUEST = 1000
export const MAX_CYCLES_PER_REQUEST = 1000

export const MAX_BETWEEN_CYCLES_PER_REQUEST = 100

async function start(): Promise<void> {
  const configFilePath = overrideDefaultConfig(env, args)

  if (isDebugMode()) {
    //use a default key for debug mode
    //  pragma: allowlist nextline secret
    config.ARCHIVER_PUBLIC_KEY = '758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3'
    //  pragma: allowlist nextline secret
    config.ARCHIVER_HASH_KEY = '69fa4195670576c0160d660c3be36556ff8d504725be8a59b5a96509e0c994bc'
    config.ARCHIVER_SECRET_KEY =
      //  pragma: allowlist nextline secret
      '3be00019f23847529bd63e41124864983175063bb524bd54ea3c155f2fa12969758b1c119412298802cd28dbfa394cdfeecc4074492d60844cc192d632d84de3'
  } else {
    // Pull in secrets
    const secretsPath = path.join(__dirname, '../.secrets')
    const secrets = {}

    if (fs.existsSync(secretsPath)) {
      const lines = fs.readFileSync(secretsPath, 'utf-8').split('\n').filter(Boolean)

      lines.forEach((line) => {
        const [key, value] = line.split('=')
        secrets[key.trim()] = value.trim()
      })
    }

    if (secrets['ARCHIVER_PUBLIC_KEY'] === undefined) config.ARCHIVER_PUBLIC_KEY = ''
    else config.ARCHIVER_PUBLIC_KEY = secrets['ARCHIVER_PUBLIC_KEY']

    if (secrets['ARCHIVER_SECRET_KEY'] === undefined) config.ARCHIVER_SECRET_KEY = ''
    else config.ARCHIVER_SECRET_KEY = secrets['ARCHIVER_SECRET_KEY']

    if (secrets['ARCHIVER_HASH_KEY'] === undefined) config.ARCHIVER_HASH_KEY = ''
    else config.ARCHIVER_HASH_KEY = secrets['ARCHIVER_HASH_KEY']
  }
  // Now, secrets contain your secrets, for example:
  // const apiKey = secrets.API_KEY;

  // Set crypto hash keys from config
  const hashKey = config.ARCHIVER_HASH_KEY
  Crypto.setCryptoHashKey(hashKey)
  try {
    await setupArchiverDiscovery({
      hashKey,
      customConfigPath: configFilePath,
    })
  } catch (e) {
    console.log('Error setting up archiver discovery: ', e)
  }

  // If no keypair provided, generate one
  if (config.ARCHIVER_SECRET_KEY === '' || config.ARCHIVER_PUBLIC_KEY === '') {
    const keypair = Crypto.core.generateKeypair()
    config.ARCHIVER_PUBLIC_KEY = keypair.publicKey
    config.ARCHIVER_SECRET_KEY = keypair.secretKey
  }
  let logsConfig
  try {
    logsConfig = JSON.parse(readFileSync(resolve(__dirname, '../archiver-log.json'), 'utf8'))
  } catch (err) {
    console.log('Failed to parse archiver log file:', err)
  }
  logDir = `${config.ARCHIVER_LOGS}/${config.ARCHIVER_IP}_${config.ARCHIVER_PORT}`
  const baseDir = '.'
  logsConfig.dir = logDir
  Logger.initLogger(baseDir, logsConfig)
  if (logsConfig.saveConsoleOutput) {
    startSaving(join(baseDir, logsConfig.dir))
  }
  // Initialize storage
  if (config.experimentalSnapshot) {
    await dbstore.initializeDB(config)
  } else {
    await Storage.initStorage(config)
  }

  const lastStoredCycle = await CycleDB.queryLatestCycleRecords(1)
  if (lastStoredCycle && lastStoredCycle.length > 0) {
    const lastStoredCycleMode = lastStoredCycle[0].mode as P2PTypes.ModesTypes.Record['mode']
    if (lastStoredCycleMode === 'shutdown') {
      setShutdownCycleRecord(lastStoredCycle[0])
      Logger.mainLogger.debug('Found shutdown cycleRecord', cycleRecordWithShutDownMode)
      // Initialize state from config
      await State.initFromConfig(config, true)
      const result = await State.compareCycleRecordWithOtherArchivers(
        cycleRecordWithShutDownMode.archiversAtShutdown,
        cycleRecordWithShutDownMode
      )
      if (result) {
        State.resetActiveArchivers(cycleRecordWithShutDownMode.archiversAtShutdown)
        // Load global account from db
        await loadGlobalAccounts()
        io = await startServer()
        return
      }
    }
  }
  // Initialize state from config
  await State.initFromConfig(config)

  if (State.isFirst) {
    Logger.mainLogger.debug('We are first archiver. Starting archive-server')
    const lastStoredCycle = await CycleDB.queryLatestCycleRecords(1)
    if (lastStoredCycle && lastStoredCycle.length > 0) {
      // Load global account from db
      await loadGlobalAccounts()
      // Seems you got restarted, and there are no other archivers to check; build nodelists and send join request to the nodes first
      await Data.buildNodeListFromStoredCycle(lastStoredCycle[0])

      let isJoined = false
      let firstTime = true
      const cycleDuration = Cycles.currentCycleDuration
      const checkFromConsensor = true
      do {
        try {
          // Get active nodes from Archiver
          const nodeList = NodeList.getActiveList()

          // try to join the network
          isJoined = await Data.joinNetwork(nodeList, firstTime, checkFromConsensor)
        } catch (err: unknown) {
          Logger.mainLogger.error('Error while joining network:')
          Logger.mainLogger.error(err as Error)
          Logger.mainLogger.error((err as Error).stack)
          Logger.mainLogger.debug(`Trying to join again in ${cycleDuration} seconds...`)
          await Utils.sleep(cycleDuration)
        }
        firstTime = false
      } while (!isJoined)

      /**
       * [NOTE] [AS] There's a possibility that we could get stuck in this loop
       * if the joinRequest was sent in the wrong cycle quarter (Q2, Q3, or Q4).
       *
       * Since we've dealt with this problem in shardus-global-server, it might be
       * good to refactor this code to do what shardus-global-server does to join
       * the network.
       */

      Logger.mainLogger.debug('We have successfully joined the network')
      io = await startServer()
      await Data.subscribeNodeForDataTransfer()
    } else {
      io = await startServer()
    }
  } else {
    Logger.mainLogger.debug('We are not first archiver. Syncing and starting archive-server')
    syncAndStartServer()
  }
}

function initProfiler(server: Server): void {
  const memoryReporter = new MemoryReporting(server)
  setMemoryReportingInstance(memoryReporter)
  const nestedCounter = new NestedCounters(server)
  setNestedCountersInstance(nestedCounter)
  const profiler = new Profiler(server)
  setProfilerInstance(profiler)
  const statistics = new Statistics(
    logDir,
    config.STATISTICS,
    {
      counters: [],
      watchers: {},
      timers: [],
      manualStats: ['cpuPercent'],
    },
    {}
  )
  statistics.startSnapshots()
  statistics.on('snapshot', memoryReportingInstance.updateCpuPercent)

  // ========== ENDPOINTS ==========
  memoryReporter.registerEndpoints()
  nestedCounter.registerEndpoints()
  profiler.registerEndpoints()
}

/** Asynchronous function to synchronize and start the server. */
async function syncAndStartServer(): Promise<void> {
  // Validate data if there is any in db
  // Retrieve the count of receipts currently stored in the database
  let lastStoredReceiptCount = await ReceiptDB.queryReceiptCount()

  // Retrieve the count of cycles currently stored in the database
  let lastStoredCycleCount = await CycleDB.queryCyleCount()
  let lastStoredOriginalTxCount = await OriginalTxDB.queryOriginalTxDataCount()
  // Query the latest cycle record from the database
  let lastStoredCycleInfo = await CycleDB.queryLatestCycleRecords(1)

  // Select a random active archiver node from the state
  const randomArchiver = Data.getRandomArchiver()
  // Initialize last stored receipt cycle as 0
  let lastStoredReceiptCycle = 0
  let lastStoredOriginalTxCycle = 0

  interface TotalDataResponse {
    totalCycles: number
    totalAccounts: number
    totalTransactions: number
    totalReceipts: number
    totalOriginalTxs: number
  }

  // Request total data from the random archiver
  const response = (await P2P.getJson(
    `http://${randomArchiver.ip}:${randomArchiver.port}/totalData`,
    10
  )) as TotalDataResponse

  // Check if the response is valid and all data fields are non-negative
  if (
    !response ||
    response.totalCycles < 0 ||
    response.totalAccounts < 0 ||
    response.totalTransactions < 0 ||
    response.totalReceipts < 0
  ) {
    throw Error(`Can't fetch data from the archiver ${randomArchiver.ip}:${randomArchiver.port}`)
  }
  // Destructure the response to get total counts for cycles, accounts, transactions and receipts
  const { totalCycles, totalReceipts } = response

  // Check if local database has more data than the network, if so, clear the database
  if (lastStoredReceiptCount > totalReceipts || lastStoredCycleCount > totalCycles) {
    throw Error(
      'The existing db has more data than the network data! Clear the DB and start the server again!'
    )
  }

  // If there are stored cycles, validate the old cycle data
  if (lastStoredCycleCount > 0) {
    Logger.mainLogger.debug('Validating old cycles data!')

    // Compare old cycle data with the archiver data
    const cycleResult = await Data.compareWithOldCyclesData(randomArchiver, lastStoredCycleCount)

    // If the cycle data does not match, clear the DB and start again
    if (!cycleResult.success) {
      throw Error(
        'The last saved 10 cycles data does not match with the archiver data! Clear the DB and start the server again!'
      )
    }

    // Update the last stored cycle count
    lastStoredCycleCount = cycleResult.matchedCycle
  }

  // If there are stored receipts, validate the old receipt data
  if (lastStoredReceiptCount > 0) {
    Logger.mainLogger.debug('Validating old receipts data!')
    // Query latest receipts from the DB
    const lastStoredReceiptInfo = await ReceiptDB.queryLatestReceipts(1)

    // If there's any stored receipt, update lastStoredReceiptCycle
    if (lastStoredReceiptInfo && lastStoredReceiptInfo.length > 0)
      lastStoredReceiptCycle = lastStoredReceiptInfo[0].cycle

    // Compare old receipts data with the archiver data
    const receiptResult = await Data.compareWithOldReceiptsData(randomArchiver, lastStoredReceiptCycle)

    // If the receipt data does not match, clear the DB and start again
    if (!receiptResult.success) {
      throw Error(
        'The last saved receipts of last 10 cycles data do not match with the archiver data! Clear the DB and start the server again!'
      )
    }

    // Update the last stored receipt cycle
    lastStoredReceiptCycle = receiptResult.matchedCycle
  }

  if (lastStoredOriginalTxCount > 0) {
    Logger.mainLogger.debug('Validating old Original Txs data!')
    const lastStoredOriginalTxInfo = await OriginalTxDB.queryLatestOriginalTxs(1)
    if (lastStoredOriginalTxInfo && lastStoredOriginalTxInfo.length > 0)
      lastStoredOriginalTxCycle = lastStoredOriginalTxInfo[0].cycle
    const txResult = await Data.compareWithOldOriginalTxsData(randomArchiver, lastStoredOriginalTxCycle)
    if (!txResult.success) {
      throw Error(
        'The saved Original-Txs of last 10 cycles data do not match with the archiver data! Clear the DB and start the server again!'
      )
    }
    lastStoredOriginalTxCycle = txResult.matchedCycle
  }

  // Log the last stored cycle and receipt counts
  Logger.mainLogger.debug(
    'lastStoredCycleCount',
    lastStoredCycleCount,
    'lastStoredReceiptCount',
    lastStoredReceiptCount,
    'lastStoredOriginalTxCount',
    lastStoredOriginalTxCount
  )

  // If your not the first archiver node, get a nodelist from the others

  // Initialize variables for joining the network
  let isJoined = false
  let firstTime = true

  // Get the cycle duration
  const cycleDuration = await Data.getCycleDuration()

  // Attempt to join the network until successful
  do {
    try {
      const randomArchiver = Data.getRandomArchiver()
      // Get active nodes from Archiver
      const nodeList: NodeList.ConsensusNodeInfo[] =
        await NodeList.getActiveNodeListFromArchiver(randomArchiver)

      // If no nodes are active, retry the loop
      if (nodeList.length === 0) continue

      // Attempt to join the network
      isJoined = await Data.joinNetwork(nodeList, firstTime)
    } catch (err) {
      // Log the error if the joining process fails
      Logger.mainLogger.error('Error while joining network:')
      Logger.mainLogger.error(err)
      Logger.mainLogger.error(err.stack)

      // Sleep for a cycle duration and then retry
      Logger.mainLogger.debug(`Trying to join again in ${cycleDuration} seconds...`)
      await Utils.sleep(cycleDuration * 1000)
    }

    // After the first attempt, set firstTime to false
    firstTime = false
  } while (!isJoined)

  /**
   * [NOTE] [AS] There's a possibility that we could get stuck in this loop
   * if the joinRequest was sent in the wrong cycle quarter (Q2, Q3, or Q4).
   *
   * Since we've dealt with this problem in shardus-global-server, it might be
   * good to refactor this code to do what shardus-global-server does to join
   * the network.
   */

  Logger.mainLogger.debug('We have successfully joined the network')

  // Synchronize Genesis accounts and transactions from the network archivers
  await Data.syncGenesisAccountsFromArchiver() // Sync Genesis Accounts that the network start with.
  await Data.syncGenesisTransactionsFromArchiver()

  // Sync cycle and node list information
  if (config.useSyncV2 === true) {
    await Data.syncCyclesAndNodeListV2(State.activeArchivers, lastStoredCycleCount)
  } else {
    await Data.syncCyclesAndNodeList(lastStoredCycleCount)
  }

  // If experimentalSnapshot is enabled, perform receipt synchronization
  if (config.experimentalSnapshot) {
    // Sync GlobalAccountsList and cache the Global Network Account
    await syncGlobalAccount()
    // If no receipts stored, synchronize all receipts, otherwise synchronize by cycle
    if (lastStoredReceiptCount === 0) await Data.syncReceipts(lastStoredReceiptCount)
    else {
      Logger.mainLogger.debug('lastStoredReceiptCycle', lastStoredReceiptCycle)
      await Data.syncReceiptsByCycle(lastStoredReceiptCycle)
    }

    if (lastStoredOriginalTxCount === 0) await Data.syncOriginalTxs(lastStoredOriginalTxCount)
    else {
      Logger.mainLogger.debug('lastStoredOriginalTxCycle', lastStoredOriginalTxCycle)
      await Data.syncOriginalTxsByCycle(lastStoredOriginalTxCycle)
    }
    // After receipt data syncing completes, check cycle and receipt again to be sure it's not missing any data

    // Query for the cycle and receipt counts
    lastStoredReceiptCount = await ReceiptDB.queryReceiptCount()
    lastStoredOriginalTxCount = await OriginalTxDB.queryOriginalTxDataCount()
    lastStoredCycleCount = await CycleDB.queryCyleCount()
    lastStoredCycleInfo = await CycleDB.queryLatestCycleRecords(1)

    // Check for any missing data and perform syncing if necessary
    if (lastStoredCycleCount && lastStoredCycleInfo && lastStoredCycleInfo.length > 0) {
      if (lastStoredCycleCount - 1 !== lastStoredCycleInfo[0].counter) {
        throw Error(
          `The archiver has ${lastStoredCycleCount} and the latest stored cycle is ${lastStoredCycleInfo[0].counter}`
        )
      }
      // The following function also syncs Original-tx data
      await Data.syncCyclesAndReceiptsData(
        lastStoredCycleCount,
        lastStoredReceiptCount,
        lastStoredOriginalTxCount
      )
    }
  } else {
    // Sync all state metadata until no older data is fetched from other archivers
    await syncStateMetaData(State.activeArchivers)
  }

  // Wait for one cycle before sending data request if experimentalSnapshot is not enabled
  if (!config.experimentalSnapshot) await Utils.sleep(cycleDuration * 1000)

  // Start the server
  io = await startServer()

  if (!config.sendActiveMessage) {
    await Data.subscribeNodeForDataTransfer()
    return
  }
  const beforeCycle = Cycles.getCurrentCycleCounter()
  // Sending active message to the network
  let isActive = false
  while (!isActive) {
    await Data.sendActiveRequest()

    // TODO not used for now
    // isActive = await Data.checkActiveStatus()

    // Set as true for now, This needs to be removed after the active record for the archiver is added on the validator side
    isActive = true
  }
  Data.subscribeNodeForDataTransfer()

  // Sync the missing data during the cycle of sending active request
  const randomArchivers = Utils.getRandomItemFromArr(State.activeArchivers, 0, 5)
  const latestCycle = await Cycles.getNewestCycleFromArchivers(randomArchivers)
  await Data.syncCyclesAndTxsDataBetweenCycles(beforeCycle - 1, latestCycle.counter + 1)
}

export function isDebugMode(): boolean {
  return !!(config && config.MODE && config.MODE === 'debug')
}

export function getHashedDevKey(): string {
  console.log(config)
  if (config && config.DEBUG && config.DEBUG.hashedDevAuth) {
    return config.DEBUG.hashedDevAuth
  }
  return ''
}
export function getDevPublicKey(): string {
  if (config && config.DEBUG && config.DEBUG.devPublicKey) {
    return config.DEBUG.devPublicKey
  }
  return ''
}

let lastCounter = 0

const isDebugMiddleware: Middleware = (_req, res, next: () => void): void => {
  const isDebug = isDebugMode()
  if (!isDebug) {
    try {
      //auth with by checking a password against a hash
      if (_req.query.auth != null) {
        const hashedAuth = Crypto.hashObj({ key: _req.query.auth })
        const hashedDevKey = getHashedDevKey()
        // can get a hash back if no key is set
        if (hashedDevKey === '' || hashedDevKey !== hashedAuth) {
          throw new Error('FORBIDDEN. HashedDevKey authentication is failed.')
        }
        return
      }
      //auth my by checking a signature
      if (_req.query.sig != null && _req.query.sig_counter != null) {
        const ownerPk = getDevPublicKey()
        const requestSig = _req.query.sig
        //check if counter is valid
        const sigObj = {
          route: _req.url,
          count: parseInt(_req.query.sig_counter),
          sign: { owner: ownerPk, sig: requestSig },
        }

        //reguire a larger counter than before.
        if (sigObj.count < lastCounter) {
          const verified = Crypto.verify(sigObj)
          if (!verified) {
            throw new Error('FORBIDDEN. signature authentication is failed.')
          }
        } else {
          throw new Error('FORBIDDEN. signature counter is failed.')
        }
        lastCounter = sigObj.count //update counter so we can't use it again
        return
      }
      throw new Error('FORBIDDEN. Endpoint is only available in debug mode.')
    } catch (error) {
      // console.log(error)
      // throw new Error('FORBIDDEN. Endpoint is only available in debug mode.')
      res.sendJson({ error: error }, 400)
    }
  }
  next()
}

let reachabilityAllowed = true

// Define all endpoints, all requests, and start REST server
async function startServer(): Promise<SocketIO.Server> {
  const server: Server = new Server(config.ARCHIVER_PORT)
  server.registerMiddleware([
    corsMiddleware,
    rateLimitMiddleware,
    getBodyMiddleware,
    getQueryStringMiddleware,
  ])

  // Socket server instance
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  io = require('socket.io')(server.server)
  Data.initSocketServer(io)

  initProfiler(server)

  // Initialize the data log writer
  if (config.dataLogWrite) await initDataLogWriter()

  /**
   * Check the cache for the node list, if it's hot, return it. Otherwise,
   * rebuild the cache and return the node list.
   */
  const getCachedNodeList = (): NodeList.SignedNodeList => {
    const cacheUpdatedTime = NodeList.cacheUpdatedTimes.get('/nodelist')
    const realUpdatedTime = NodeList.realUpdatedTimes.get('/nodelist')

    const byAscendingNodeId = (a: NodeList.ConsensusNodeInfo, b: NodeList.ConsensusNodeInfo): number =>
      a.id > b.id ? 1 : -1
    const bucketCacheKey = (index: number): string => `/nodelist/${index}`

    if (cacheUpdatedTime && realUpdatedTime && cacheUpdatedTime > realUpdatedTime) {
      // cache is hot, send cache

      const randomIndex = Math.floor(Math.random() * config.N_RANDOM_NODELIST_BUCKETS)
      const cachedNodeList = NodeList.cache.get(bucketCacheKey(randomIndex))
      return cachedNodeList
    }

    // cache is cold, remake cache
    const nodeCount = Math.min(config.N_NODELIST, NodeList.getActiveList().length)

    for (let index = 0; index < config.N_RANDOM_NODELIST_BUCKETS; index++) {
      // If we dont have any active nodes, send back the first node in our list
      const nodeList =
        nodeCount < 1 ? NodeList.getList().slice(0, 1) : NodeList.getRandomActiveNodes(nodeCount)
      const sortedNodeList = [...nodeList].sort(byAscendingNodeId)
      const signedSortedNodeList = Crypto.sign({
        nodeList: sortedNodeList,
      })

      // Update cache
      NodeList.cache.set(bucketCacheKey(index), signedSortedNodeList)
    }

    // Update cache timestamps
    if (NodeList.realUpdatedTimes.get('/nodelist') === undefined) {
      // This gets set when the list of nodes changes. For the first time, set to a large value
      NodeList.realUpdatedTimes.set('/nodelist', Infinity)
    }
    NodeList.cacheUpdatedTimes.set('/nodelist', Date.now())

    const nodeList = NodeList.cache.get(bucketCacheKey(0))
    return nodeList
  }

  /**
   * ENTRY POINT: New Shardus network
   *
   * Consensus node zero (CZ) posts IP and port to archiver node zero (AZ).
   *
   * AZ adds CZ to nodelist, sets CZ as dataSender, and responds with
   * nodelist + archiver join request
   *
   * CZ adds AZ's join reqeuest to cycle zero and sets AZ as cycleRecipient
   */
  type NodeListRequest = P2P.FirstNodeInfo & Crypto.SignedMessage

  server.registerRoute('GET', '/myip', (_request, reply) => {
    const ip = _request.socket.remoteAddress
    reply.end({ ip })
  })

  server.registerRoute('POST', '/nodelist', async (request, reply) => {
    profilerInstance.profileSectionStart('POST_nodelist')
    nestedCountersInstance.countEvent('consensor', 'POST_nodelist', 1)
    const signedFirstNodeInfo = request.body as unknown as NodeListRequest
    if (State.isFirst && NodeList.isEmpty() && !NodeList.foundFirstNode) {
      try {
        const isSignatureValid = Crypto.verify(signedFirstNodeInfo)
        if (!isSignatureValid) {
          Logger.mainLogger.error('Invalid signature', signedFirstNodeInfo)
          return
        }
      } catch (e) {
        Logger.mainLogger.error(e)
      }
      NodeList.toggleFirstNode()
      const ip = signedFirstNodeInfo.nodeInfo.externalIp
      const port = signedFirstNodeInfo.nodeInfo.externalPort
      const publicKey = signedFirstNodeInfo.nodeInfo.publicKey

      const firstNode: NodeList.ConsensusNodeInfo = {
        ip,
        port,
        publicKey,
      }

      Data.initSocketClient(firstNode)

      // Add first node to NodeList
      NodeList.addNodes(NodeList.NodeStatus.SYNCING, 'bogus', [firstNode])

      // Set first node as dataSender
      const firstDataSender: Data.DataSender = {
        nodeInfo: firstNode,
        types: [P2PTypes.SnapshotTypes.TypeNames.CYCLE, P2PTypes.SnapshotTypes.TypeNames.STATE_METADATA],
        contactTimeout: Data.createContactTimeout(
          firstNode.publicKey,
          'This timeout is created for the first node'
        ),
      }
      Data.addDataSender(firstDataSender)
      let res: P2P.FirstNodeResponse

      if (config.experimentalSnapshot) {
        const data = {
          nodeList: NodeList.getList(),
        }
        if (cycleRecordWithShutDownMode) {
          // For restore network to start the network from the 'restart' mode
          data['restartCycleRecord'] = cycleRecordWithShutDownMode
          data['dataRequestCycle'] = cycleRecordWithShutDownMode.counter
        } else {
          // For new network to start the network from the 'forming' mode
          data['joinRequest'] = P2P.createArchiverJoinRequest()
          data['dataRequestCycle'] = Cycles.getCurrentCycleCounter()
        }

        res = Crypto.sign<P2P.FirstNodeResponse>(data)
      } else {
        res = Crypto.sign<P2P.FirstNodeResponse>({
          nodeList: NodeList.getList(),
          joinRequest: P2P.createArchiverJoinRequest(),
          dataRequestCycle: Data.createDataRequest<Cycles.Cycle>(
            P2PTypes.SnapshotTypes.TypeNames.CYCLE,
            Cycles.getCurrentCycleCounter(),
            publicKey
          ),
          dataRequestStateMetaData: Data.createDataRequest<P2PTypes.SnapshotTypes.StateMetaData>(
            P2PTypes.SnapshotTypes.TypeNames.STATE_METADATA,
            Cycles.lastProcessedMetaData,
            publicKey
          ),
        })
      }
      reply.sendJson(res)
    } else {
      // Note, this is doing the same thing as GET /nodelist. However, it has been kept for backwards
      // compatibility.
      const res = getCachedNodeList()
      reply.sendJson(res)
    }
    profilerInstance.profileSectionEnd('POST_nodelist')
  })

  server.registerRoute('GET', '/nodelist', (_request, reply) => {
    profilerInstance.profileSectionStart('GET_nodelist')
    nestedCountersInstance.countEvent('consensor', 'GET_nodelist')

    const nodeList = getCachedNodeList()
    profilerInstance.profileSectionEnd('GET_nodelist')

    reply.sendJson(nodeList)
  })

  type FullNodeListRequest = {
    activeOnly: 'true' | 'false'
    syncingOnly: 'true' | 'false'
    standbyOnly: 'true' | 'false'
  }

  server.registerRoute('GET', '/full-nodelist', [isDebugMiddleware], (_request, reply) => {
    try {
      profilerInstance.profileSectionStart('FULL_nodelist')
      nestedCountersInstance.countEvent('consensor', 'FULL_nodelist')
      const { activeOnly, syncingOnly, standbyOnly } = _request.query as FullNodeListRequest
      const activeNodeList = NodeList.getActiveList()
      const syncingNodeList = NodeList.getSyncingList()
      if (activeOnly === 'true') reply.sendJson(Crypto.sign({ nodeList: activeNodeList }))
      else if (syncingOnly === 'true') reply.sendJson(Crypto.sign({ nodeList: syncingNodeList }))
      else if (standbyOnly === 'true') {
        const standbyNodeList = NodeList.getStandbyList()
        reply.sendJson(Crypto.sign({ nodeList: standbyNodeList }))
      } else {
        const fullNodeList = activeNodeList.concat(syncingNodeList)
        reply.sendJson(Crypto.sign({ nodeList: fullNodeList }))
      }
      profilerInstance.profileSectionEnd('FULL_nodelist')
    } catch (e) {
      console.log(e)
    }
  })

  server.registerRoute('GET', '/removed', [isDebugMiddleware], (_request, reply) => {
    profilerInstance.profileSectionStart('removed')
    nestedCountersInstance.countEvent('consensor', 'removed')
    reply.send(Crypto.sign({ removedNodes: Cycles.removedNodes }))
    profilerInstance.profileSectionEnd('removed')
  })

  type LostRequest = { start: string; end: string }

  server.registerRoute('GET', '/lost', async (_request, reply) => {
    let { start, end } = _request.query as LostRequest
    if (!start) start = '0'
    if (!end) end = Cycles.getCurrentCycleCounter().toString()

    const from = parseInt(start)
    const to = parseInt(end)
    if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
      reply.sendJson(Crypto.sign({ success: false, error: `Invalid start and end counters` }))
      return
    }
    let lostNodes = []
    lostNodes = Cycles.getLostNodes(from, to)
    const res = Crypto.sign({
      lostNodes,
    })
    reply.sendJson(res)
  })

  server.registerRoute('GET', '/archivers', (_request, reply) => {
    profilerInstance.profileSectionStart('GET_archivers')
    nestedCountersInstance.countEvent('consensor', 'GET_archivers')
    const activeArchivers = State.activeArchivers
      .filter(
        (archiver) =>
          State.archiversReputation.has(archiver.publicKey) &&
          State.archiversReputation.get(archiver.publicKey) === 'up'
      )
      .map(({ publicKey, ip, port }) => ({ publicKey, ip, port }))
    profilerInstance.profileSectionEnd('GET_archivers')
    const res = Crypto.sign({
      activeArchivers,
    })
    reply.sendJson(res)
  })

  server.registerRoute('GET', '/nodeInfo', (request, reply) => {
    if (reachabilityAllowed) {
      reply.sendJson({
        publicKey: config.ARCHIVER_PUBLIC_KEY,
        ip: config.ARCHIVER_IP,
        port: config.ARCHIVER_PORT,
        version,
        time: Date.now(),
      })
    } else {
      request.socket.destroy()
    }
  })

  type CycleInfoRequest = { start: string; end: string; download: 'true' | 'false' }

  server.registerRoute('GET', '/cycleinfo', async (_request, reply) => {
    const params = _request.params as CycleInfoRequest

    let { start, end } = params
    const { download } = params
    if (!start) start = '0'
    if (!end) end = start
    const from = parseInt(start)
    const to = parseInt(end)
    const isDownload: boolean = download === 'true'

    if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
      Logger.mainLogger.error(`Invalid start and end counters`)
      reply.sendJson(Crypto.sign({ success: false, error: `Invalid start and end counters` }))
      return
    }
    const cycleCount = to - from
    if (cycleCount > MAX_CYCLES_PER_REQUEST) {
      Logger.mainLogger.error(`Exceed maximum limit of ${MAX_CYCLES_PER_REQUEST} cycles`)
      reply.sendJson(
        Crypto.sign({
          success: false,
          error: `Exceed maximum limit of ${MAX_CYCLES_PER_REQUEST} cycles`,
        })
      )
      return
    }
    let cycleInfo = []
    if (config.experimentalSnapshot) cycleInfo = await CycleDB.queryCycleRecordsBetween(from, to)
    else cycleInfo = await Storage.queryCycleRecordsBetween(from, to)
    if (isDownload) {
      const dataInBuffer = Buffer.from(JSON.stringify(cycleInfo), 'utf-8')
      const dataInStream = Readable.from(dataInBuffer)
      const filename = `cycle_records_from_${from}_to_${to}`

      reply.setHeader('content-disposition', `attachment; filename="${filename}"`)
      reply.setHeader('content-type', 'application/octet-stream')
      reply.end(dataInStream)
    } else {
      const res = Crypto.sign({
        cycleInfo,
      })
      reply.sendJson(res)
    }
  })

  type CycleInfoCountRequest = { count: string }

  server.registerRoute('GET', '/cycleinfo/:count', async (_request, reply) => {
    const err = Utils.validateTypes(_request.params as CycleInfoCountRequest, { count: 's' })

    if (err) {
      reply.sendJson(Crypto.sign({ success: false, error: err }))
      return
    }
    let count: number = parseInt(_request.params.count)
    if (count <= 0 || Number.isNaN(count)) {
      reply.sendJson(Crypto.sign({ success: false, error: `Invalid count` }))
      return
    }
    if (count > MAX_CYCLES_PER_REQUEST) count = MAX_CYCLES_PER_REQUEST
    let cycleInfo: any[] // eslint-disable-line @typescript-eslint/no-explicit-any
    if (config.experimentalSnapshot) cycleInfo = await CycleDB.queryLatestCycleRecords(count)
    else cycleInfo = await Storage.queryLatestCycleRecords(count)
    const res = Crypto.sign({
      cycleInfo,
    })
    reply.sendJson(res)
  })

  server.registerRoute('GET', '/originalTx', async (_request, reply) => {
    const err = Utils.validateTypes(_request.query as ReceiptQuery, {
      start: 's?',
      end: 's?',
      startCycle: 's?',
      endCycle: 's?',
      type: 's?',
      page: 's?',
      txId: 's?',
      txIdList: 's?',
    })
    if (err) {
      reply.sendJson(Crypto.sign({ success: false, error: err }))
      return
    }
    const { start, end, startCycle, endCycle, type, page, txId, txIdList } = _request.query
    let originalTxs: any = [] // eslint-disable-line @typescript-eslint/no-explicit-any

    if (txId) {
      if (txId.length !== TXID_LENGTH) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid txId ${txId}`,
          })
        )
        return
      }
      originalTxs = await OriginalTxDB.queryOriginalTxDataByTxId(txId)
    } else if (txIdList) {
      let txIdListArr = []
      try {
        txIdListArr = JSON.parse(txIdList)
      } catch (e) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid txIdList ${txIdList}`,
          })
        )
        return
      }
      for (const txId of txIdListArr) {
        if (typeof txId !== 'string' || txId.length !== TXID_LENGTH) {
          reply.sendJson(
            Crypto.sign({
              success: false,
              error: `Invalid txId ${txId} in the List`,
            })
          )
          return
        }
        const originalTx = await OriginalTxDB.queryOriginalTxDataByTxId(txId)
        if (originalTx) originalTxs.push(originalTx)
      }
    } else if (start || end) {
      const from = start ? parseInt(start) : 0
      const to = end ? parseInt(end) : from
      if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid start and end counters`,
          })
        )
        return
      }
      let count = to - from
      if (count > MAX_ORIGINAL_TXS_PER_REQUEST) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Exceed maximum limit of ${MAX_ORIGINAL_TXS_PER_REQUEST} original transactions`,
          })
        )
        return
      }
      originalTxs = await OriginalTxDB.queryOriginalTxsData(from, ++count)
    } else if (startCycle || endCycle) {
      const from = startCycle ? parseInt(startCycle) : 0
      const to = endCycle ? parseInt(endCycle) : from
      if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid startCycle and endCycle counters`,
          })
        )
        return
      }
      const count = to - from
      if (count > MAX_BETWEEN_CYCLES_PER_REQUEST) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Exceed maximum limit of ${MAX_BETWEEN_CYCLES_PER_REQUEST} cycles`,
          })
        )
        return
      }
      if (type === 'tally') {
        originalTxs = await OriginalTxDB.queryOriginalTxDataCountByCycles(from, to)
      } else if (type === 'count') {
        originalTxs = await OriginalTxDB.queryOriginalTxDataCount(from, to)
      } else {
        let skip = 0
        const limit = MAX_ORIGINAL_TXS_PER_REQUEST
        if (page) {
          const page_number = parseInt(page)
          if (page_number < 1 || Number.isNaN(page_number)) {
            reply.sendJson(Crypto.sign({ success: false, error: `Invalid page number` }))
            return
          }
          skip = page_number - 1
          if (skip > 0) skip = skip * limit
        }
        originalTxs = await OriginalTxDB.queryOriginalTxsData(skip, limit, from, to)
      }
    }
    const res = Crypto.sign({
      originalTxs,
    })
    reply.sendJson(res)
  })

  server.registerRoute('GET', '/receipt', async (_request, reply) => {
    const err = Utils.validateTypes(_request.query as ReceiptQuery, {
      start: 's?',
      end: 's?',
      startCycle: 's?',
      endCycle: 's?',
      type: 's?',
      page: 's?',
      txId: 's?',
      txIdList: 's?',
    })
    if (err) {
      reply.sendJson(Crypto.sign({ success: false, error: err }))
      return
    }
    const { start, end, startCycle, endCycle, type, page, txId, txIdList } = _request.query
    let receipts = []
    if (txId) {
      if (txId.length !== TXID_LENGTH) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid txId ${txId}`,
          })
        )
        return
      }
      const receipt = await ReceiptDB.queryReceiptByReceiptId(txId)
      if (receipt) receipts.push(receipt)
    } else if (txIdList) {
      let txIdListArr = []
      try {
        txIdListArr = JSON.parse(txIdList)
      } catch (e) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid txIdList ${txIdList}`,
          })
        )
        return
      }
      for (const txId of txIdListArr) {
        if (typeof txId !== 'string' || txId.length !== TXID_LENGTH) {
          reply.sendJson(
            Crypto.sign({
              success: false,
              error: `Invalid txId ${txId} in the List`,
            })
          )
          return
        }
        const receipt = await ReceiptDB.queryReceiptByReceiptId(txId)
        if (receipt) receipts.push(receipt)
      }
    } else if (start || end) {
      const from = start ? parseInt(start) : 0
      const to = end ? parseInt(end) : from
      if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid start and end counters`,
          })
        )
        return
      }
      let count = to - from
      if (count > MAX_RECEIPTS_PER_REQUEST) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Exceed maximum limit of ${MAX_RECEIPTS_PER_REQUEST} receipts`,
          })
        )
        return
      }
      receipts = await ReceiptDB.queryReceipts(from, ++count)
    } else if (startCycle || endCycle) {
      const from = startCycle ? parseInt(startCycle) : 0
      const to = endCycle ? parseInt(endCycle) : from
      if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid startCycle and endCycle counters`,
          })
        )
        return
      }
      const count = to - from
      if (count > MAX_BETWEEN_CYCLES_PER_REQUEST) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Exceed maximum limit of ${MAX_BETWEEN_CYCLES_PER_REQUEST} cycles`,
          })
        )
        return
      }
      if (type === 'tally') {
        receipts = await ReceiptDB.queryReceiptCountByCycles(from, to)
      } else if (type === 'count') {
        const receipt = await ReceiptDB.queryReceiptCountBetweenCycles(from, to)
        if (receipt) receipts.push()
      } else {
        let skip = 0
        const limit = MAX_RECEIPTS_PER_REQUEST
        if (page) {
          const page_number = parseInt(page)
          if (page_number < 1 || Number.isNaN(page_number)) {
            reply.sendJson(Crypto.sign({ success: false, error: `Invalid page number` }))
            return
          }
          skip = page_number - 1
          if (skip > 0) skip = skip * limit
        }
        receipts = await ReceiptDB.queryReceiptsBetweenCycles(skip, limit, from, to)
      }
    }
    const res = Crypto.sign({
      receipts,
    })
    reply.sendJson(res)
  })

  type ReceiptCountRequest = {
    count: string
  }

  server.registerRoute('GET', '/receipt/:count', async (_request, reply) => {
    const err = Utils.validateTypes(_request.params as ReceiptCountRequest, { count: 's' })
    if (err) {
      reply.sendJson(Crypto.sign({ success: false, error: err }))
      return
    }

    const count: number = parseInt(_request.params.count)
    if (count <= 0 || Number.isNaN(count)) {
      reply.sendJson(Crypto.sign({ success: false, error: `Invalid count` }))
      return
    }
    if (count > MAX_RECEIPTS_PER_REQUEST) {
      reply.sendJson(Crypto.sign({ success: false, error: `Max count is ${MAX_RECEIPTS_PER_REQUEST}` }))
      return
    }
    const receipts = await ReceiptDB.queryLatestReceipts(count)
    const res = Crypto.sign({
      receipts,
    })
    reply.sendJson(res)
  })

  server.registerRoute('GET', '/account', async (_request, reply) => {
    const err = Utils.validateTypes(_request.query as AccountQuery, {
      start: 's?',
      end: 's?',
      startCycle: 's?',
      endCycle: 's?',
      page: 's?',
      address: 's?',
      accountId: 's?',
    })
    if (err) {
      reply.sendJson(Crypto.sign({ success: false, error: err }))
      return
    }
    let accounts = []
    let totalAccounts = 0
    let res
    const { start, end, startCycle, endCycle, page, accountId } = _request.query
    if (start || end) {
      const from = start ? parseInt(start) : 0
      const to = end ? parseInt(end) : from
      if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid start and end counters`,
          })
        )
        return
      }
      let count = to - from
      if (count > MAX_ACCOUNTS_PER_REQUEST) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Exceed maximum limit of ${MAX_ACCOUNTS_PER_REQUEST} accounts`,
          })
        )
        return
      }
      accounts = await AccountDB.queryAccounts(from, ++count)
      res = Crypto.sign({
        accounts,
      })
    } else if (startCycle || endCycle) {
      const from = startCycle ? parseInt(startCycle) : 0
      const to = endCycle ? parseInt(endCycle) : from
      if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid start and end counters`,
          })
        )
        return
      }
      const count = to - from
      if (count > MAX_BETWEEN_CYCLES_PER_REQUEST) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Exceed maximum limit of ${MAX_BETWEEN_CYCLES_PER_REQUEST} cycles to query accounts Count`,
          })
        )
        return
      }
      totalAccounts = await AccountDB.queryAccountCountBetweenCycles(from, to)
      if (page) {
        const page_number = parseInt(page)
        if (page_number < 1 || Number.isNaN(page_number)) {
          reply.sendJson(Crypto.sign({ success: false, error: `Invalid page number` }))
          return
        }
        let skip = page_number - 1
        const limit = MAX_ACCOUNTS_PER_REQUEST
        if (skip > 0) skip = skip * limit
        accounts = await AccountDB.queryAccountsBetweenCycles(skip, limit, from, to)
      }
      res = Crypto.sign({
        accounts,
        totalAccounts,
      })
    } else if (accountId) {
      const account = await AccountDB.queryAccountByAccountId(accountId)
      if (account) accounts.push(account)
      res = Crypto.sign({
        accounts,
      })
    } else {
      reply.sendJson({
        success: false,
        error: 'not specified which account to show',
      })
      return
    }
    reply.sendJson(res)
  })

  type AccountCountRequest = {
    count: string
  }

  server.registerRoute('GET', '/account/:count', async (_request, reply) => {
    const err = Utils.validateTypes(_request.params as AccountCountRequest, { count: 's' })
    if (err) {
      reply.sendJson(Crypto.sign({ success: false, error: err }))
      return
    }

    const count: number = parseInt(_request.params.count)
    if (count <= 0 || Number.isNaN(count)) {
      reply.sendJson(Crypto.sign({ success: false, error: `Invalid count` }))
      return
    }
    if (count > MAX_ACCOUNTS_PER_REQUEST) {
      reply.sendJson(Crypto.sign({ success: false, error: `Max count is ${MAX_ACCOUNTS_PER_REQUEST}` }))
      return
    }
    const accounts = await AccountDB.queryLatestAccounts(count)
    const res = Crypto.sign({
      accounts,
    })
    reply.sendJson(res)
  })

  server.registerRoute('GET', '/transaction', async (_request, reply) => {
    const err = Utils.validateTypes(_request.query as TransactionQuery, {
      start: 's?',
      end: 's?',
      txId: 's?',
      accountId: 's?',
      startCycle: 's?',
      endCycle: 's?',
      page: 's?',
    })
    if (err) {
      reply.sendJson(Crypto.sign({ success: false, error: err }))
      return
    }
    const { start, end, txId, accountId, startCycle, endCycle, page } = _request.query
    let transactions = []
    let totalTransactions = 0
    let res
    if (start || end) {
      const from = start ? parseInt(start) : 0
      const to = end ? parseInt(end) : from
      if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid start and end counters`,
          })
        )
        return
      }
      let count = to - from
      if (count > MAX_ACCOUNTS_PER_REQUEST) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Exceed maximum limit of ${MAX_ACCOUNTS_PER_REQUEST} transactions`,
          })
        )
        return
      }
      transactions = await TransactionDB.queryTransactions(from, ++count)
      res = Crypto.sign({
        transactions,
      })
    } else if (startCycle || endCycle) {
      const from = startCycle ? parseInt(startCycle) : 0
      const to = endCycle ? parseInt(endCycle) : from
      if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Invalid start and end counters`,
          })
        )
        return
      }
      const count = to - from
      if (count > MAX_BETWEEN_CYCLES_PER_REQUEST) {
        reply.sendJson(
          Crypto.sign({
            success: false,
            error: `Exceed maximum limit of ${MAX_BETWEEN_CYCLES_PER_REQUEST} cycles to query transactions Count`,
          })
        )
        return
      }
      totalTransactions = await TransactionDB.queryTransactionCountBetweenCycles(from, to)
      if (page) {
        const page_number = parseInt(page)
        if (page_number < 1 || Number.isNaN(page_number)) {
          reply.sendJson(Crypto.sign({ success: false, error: `Invalid page number` }))
          return
        }
        let skip = page_number - 1
        const limit = MAX_ACCOUNTS_PER_REQUEST
        if (skip > 0) skip = skip * limit
        transactions = await TransactionDB.queryTransactionsBetweenCycles(skip, limit, from, to)
      }
      res = Crypto.sign({
        transactions,
        totalTransactions,
      })
    } else if (txId) {
      const transaction = await TransactionDB.queryTransactionByTxId(txId)
      if (transaction) transactions.push(transaction)
      res = Crypto.sign({
        transactions,
      })
    } else if (accountId) {
      const transaction = await TransactionDB.queryTransactionByAccountId(accountId)
      if (transaction) transactions.push(transaction)
      res = Crypto.sign({
        transactions,
      })
    } else {
      res = {
        success: false,
        error: 'not specified which account to show',
      }
    }
    reply.sendJson(res)
  })

  type TransactionCountRequest = {
    count: string
  }

  server.registerRoute('GET', '/transaction/:count', async (_request, reply) => {
    const err = Utils.validateTypes(_request.params as TransactionCountRequest, { count: 's' })
    if (err) {
      reply.sendJson(Crypto.sign({ success: false, error: err }))
      return
    }

    const count: number = parseInt(_request.params.count)
    if (count <= 0 || Number.isNaN(count)) {
      reply.sendJson(Crypto.sign({ success: false, error: `Invalid count` }))
      return
    }
    if (count > MAX_ACCOUNTS_PER_REQUEST) {
      reply.sendJson(Crypto.sign({ success: false, error: `Max count is ${MAX_ACCOUNTS_PER_REQUEST}` }))
      return
    }
    const transactions = await TransactionDB.queryLatestTransactions(count)
    const res = Crypto.sign({
      transactions,
    })
    reply.sendJson(res)
  })

  server.registerRoute('GET', '/totalData', async (_request, reply) => {
    const totalCycles = await CycleDB.queryCyleCount()
    const totalAccounts = await AccountDB.queryAccountCount()
    const totalTransactions = await TransactionDB.queryTransactionCount()
    const totalReceipts = await ReceiptDB.queryReceiptCount()
    const totalOriginalTxs = await OriginalTxDB.queryOriginalTxDataCount()
    reply.sendJson({
      totalCycles,
      totalAccounts,
      totalTransactions,
      totalReceipts,
      totalOriginalTxs,
    })
  })

  type GossipDataRequest = GossipData.GossipData

  server.registerRoute('POST', '/gossip-data', async (_request, reply) => {
    const gossipPayload = _request.body as unknown as GossipDataRequest
    if (config.VERBOSE) Logger.mainLogger.debug('Gossip Data received', JSON.stringify(gossipPayload))
    const result = Collector.validateGossipData(gossipPayload)
    if (!result.success) {
      reply.sendJson(Crypto.sign({ success: false, error: result.error }))
      return
    }
    const res = Crypto.sign({
      success: true,
    })
    reply.sendJson(res)
    Collector.processGossipData(gossipPayload)
  })

  server.registerRoute('POST', '/get_account_data_archiver', async (_request, reply) => {
    const payload = _request.body as unknown as AccountDataProvider.AccountDataRequestSchema
    if (config.VERBOSE) Logger.mainLogger.debug('Account Data received', JSON.stringify(payload))
    const result = AccountDataProvider.validateAccountDataRequest(payload)
    // Logger.mainLogger.debug('Account Data validation result', result)
    if (!result.success) {
      reply.sendJson(Crypto.sign({ success: false, error: result.error }))
      return
    }
    const data = await AccountDataProvider.provideAccountDataRequest(payload)
    // Logger.mainLogger.debug('Account Data result', data)
    const res = Crypto.sign({
      success: true,
      data,
    })
    reply.sendJson(res)
  })

  server.registerRoute('POST', '/get_account_data_by_list_archiver', async (_request, reply) => {
    const payload = _request.body as unknown as AccountDataProvider.AccountDataByListRequestSchema
    if (config.VERBOSE) Logger.mainLogger.debug('Account Data By List received', JSON.stringify(payload))
    const result = AccountDataProvider.validateAccountDataByListRequest(payload)
    // Logger.mainLogger.debug('Account Data By List validation result', result)
    if (!result.success) {
      reply.sendJson(Crypto.sign({ success: false, error: result.error }))
      return
    }
    const accountData = await AccountDataProvider.provideAccountDataByListRequest(payload)
    // Logger.mainLogger.debug('Account Data By List result', accountData)
    const res = Crypto.sign({
      success: true,
      accountData,
    })
    reply.sendJson(res)
  })

  server.registerRoute('POST', '/get_globalaccountreport_archiver', async (_request, reply) => {
    const payload = _request.body as unknown as AccountDataProvider.GlobalAccountReportRequestSchema
    if (config.VERBOSE) Logger.mainLogger.debug('Global Account Report received', JSON.stringify(payload))
    const result = AccountDataProvider.validateGlobalAccountReportRequest(payload)
    // Logger.mainLogger.debug('Global Account Report validation result', result)
    if (!result.success) {
      reply.sendJson(Crypto.sign({ success: false, error: result.error }))
      return
    }
    const report = await AccountDataProvider.provideGlobalAccountReportRequest()
    // Logger.mainLogger.debug('Global Account Report result', report)
    const res = Crypto.sign(report)
    reply.sendJson(res)
  })

  // // [TODO] Remove this before production
  // // server.get('/exit', (_request, reply) => {
  // //   reply.send('Shutting down...')
  // //   process.exit()
  // // })

  // // [TODO] Remove this before production
  server.registerRoute('GET', '/nodeids', [isDebugMiddleware], (_request, reply) => {
    reply.sendJson(NodeList.byId)
  })

  // // Config Endpoint
  server.registerRoute('GET', '/config', [isDebugMiddleware], (_request, reply) => {
    const res = Crypto.sign(config)
    reply.sendJson(res)
  })

  // dataSenders Endpoint
  server.registerRoute('GET', '/dataSenders', [isDebugMiddleware], (_request, reply) => {
    const data = {
      dataSendersSize: Data.dataSenders.size,
      socketClientsSize: Data.socketClients.size,
    }
    if (_request.query && _request.query['dataSendersList'] === 'true')
      data['dataSendersList'] = Array.from(Data.dataSenders.values()).map(
        (item) => item.nodeInfo.ip + ':' + item.nodeInfo.port
      )
    const res = Crypto.sign(data)
    reply.sendJson(res)
  })

  const enableLoseYourself = false // set this to `true` during testing, but never commit as `true`

  server.registerRoute('GET', '/lose-yourself', [isDebugMiddleware], (_request, reply) => {
    if (enableLoseYourself) {
      Logger.mainLogger.debug('/lose-yourself: exit(1)')

      reply.send(Crypto.sign({ status: 'success', message: 'will exit' }))

      // We don't call exitArchiver() here because that awaits Data.sendLeaveRequest(...),
      // but we're simulating a lost node.
      process.exit(1)
    } else {
      Logger.mainLogger.debug('/lose-yourself: not enabled. no action taken.')
      reply.send(Crypto.sign({ status: 'failure', message: 'not enabled' }))
      // set enableLoseYourself to true--but never commit!
    }
  })

  // // ping the archiver to see if it's alive
  server.registerRoute('GET', '/ping', [isDebugMiddleware], (request, reply) => {
    if (reachabilityAllowed) {
      reply.send('pong!')
    } else {
      request.socket.destroy()
    }
  })

  server.registerRoute('GET', '/set-reachability', [isDebugMiddleware], async (request, reply) => {
    const msg = `/set-reachability`
    console.log(msg)
    Logger.mainLogger.info(msg)
    const value = (request.query as unknown as { value: boolean }).value
    if (typeof value !== 'boolean') {
      Logger.mainLogger.info('/set-reachability: value must be a boolean')
      reply.send('value must be a boolean', 400)
    } else {
      const msg = `/set-reachability: ${value}`
      console.log(msg)
      Logger.mainLogger.info(msg)
      reachabilityAllowed = value
    }
  })

  // Old snapshot ArchivedCycle endpoint;
  if (!config.experimentalSnapshot) {
    server.registerRoute('GET', '/full-archive', async (_request, reply) => {
      const err = Utils.validateTypes(_request.query as FullArchiveQuery, { start: 's', end: 's' })
      if (err) {
        reply.send(Crypto.sign({ success: false, error: err }))
        return
      }
      const { start, end } = _request.query
      const from = start ? parseInt(start) : 0
      const to = end ? parseInt(end) : from
      if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
        reply.send(Crypto.sign({ success: false, error: `Invalid start and end counters` }))
        return
      }
      const count = to - from
      if (count > MAX_BETWEEN_CYCLES_PER_REQUEST) {
        reply.send(
          Crypto.sign({
            success: false,
            error: `Exceed maximum limit of ${MAX_BETWEEN_CYCLES_PER_REQUEST} cycles`,
          })
        )
        return
      }
      let archivedCycles = []
      archivedCycles = await Storage.queryAllArchivedCyclesBetween(from, to)
      const res = Crypto.sign({
        archivedCycles,
      })
      reply.send(res)
    })

    type FullArchiveCountRequest = {
      count: string
    }

    server.registerRoute('GET', '/full-archive/:count', async (_request, reply) => {
      const err = Utils.validateTypes(_request.params as FullArchiveCountRequest, { count: 's' })
      if (err) {
        reply.sendJson(Crypto.sign({ success: false, error: err }))
        return
      }

      const count: number = parseInt(_request.params.count)
      if (count <= 0 || Number.isNaN(count)) {
        reply.sendJson(Crypto.sign({ success: false, error: `Invalid count` }))
        return
      }
      if (count > MAX_BETWEEN_CYCLES_PER_REQUEST) {
        reply.sendJson(
          Crypto.sign({ success: false, error: `Max count is ${MAX_BETWEEN_CYCLES_PER_REQUEST}` })
        )
        return
      }
      const archivedCycles = await Storage.queryAllArchivedCycles(count)
      const res = Crypto.sign({
        archivedCycles,
      })
      reply.sendJson(res)
    })

    type GossipHashesRequest = {
      sender: string
      data: any // eslint-disable-line @typescript-eslint/no-explicit-any
    }

    server.registerRoute('POST', '/gossip-hashes', async (_request, reply) => {
      const gossipMessage = _request.body as unknown as GossipHashesRequest
      Logger.mainLogger.debug('Gossip received', JSON.stringify(gossipMessage))
      addHashesGossip(gossipMessage.sender, gossipMessage.data)
      const res = Crypto.sign({
        success: true,
      })
      reply.sendJson(res)
    })
  }

  server.registerRoute('GET', '/get-network-account', (_request, reply) => {
    const { hash } = _request.query
    const useHash = hash !== 'false'

    const response = useHash
      ? { networkAccountHash: getGlobalNetworkAccount(useHash) }
      : { networkAccount: getGlobalNetworkAccount(useHash) }

    // We might want to sign this response
    const res = Crypto.sign(response)
    reply.sendJson(res)
  })

  // Start server and bind to port on all interfaces
  server.start(
    () => {
      Logger.mainLogger.debug('Listening', config.ARCHIVER_PORT)
      Logger.mainLogger.debug('Archive-server has started.')
      State.setActive()
      State.addSigListeners()
      Collector.scheduleCacheCleanup()
      Collector.scheduleMissingTxsDataQuery()
    },
    (err) => {
      // server.log.error(err)
      process.exit(1)
    }
  )
  return io
}

start()
