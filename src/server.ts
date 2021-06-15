import { join } from 'path'
import * as fastify from 'fastify'
import * as fastifyCors from 'fastify-cors'
import { Server, IncomingMessage, ServerResponse } from 'http'
import { overrideDefaultConfig, config } from './Config'
import * as Crypto from './Crypto'
import * as State from './State'
import * as NodeList from './NodeList'
import * as P2P from './P2P'
import * as Storage from './Storage'
import * as Data from './Data/Data'
import * as Cycles from './Data/Cycles'
import * as Utils from './shared-functions/Utils'
import { sendGossip, addHashesGossip } from './Data/Gossip'
import * as Logger from './Logger'
import { StateMetaData } from './shared-types/State'
import { TypeNames } from './shared-types/Cycle/ArchiversTypes'
import { NodeStatus } from './shared-types/Cycle/P2PTypes'


// Socket modules
let io: SocketIO.Server

// Override default config params from config file, env vars, and cli args
const file = join(process.cwd(), 'archiver-config.json')
const env = process.env
const args = process.argv

async function start() {
  overrideDefaultConfig(file, env, args)
 
  // Set crypto hash key from config
  Crypto.setCryptoHashKey(config.ARCHIVER_HASH_KEY)

  // If no keypair provided, generate one
  if (config.ARCHIVER_SECRET_KEY === '' || config.ARCHIVER_PUBLIC_KEY === '') {
    const keypair = Crypto.core.generateKeypair()
    config.ARCHIVER_PUBLIC_KEY = keypair.publicKey
    config.ARCHIVER_SECRET_KEY = keypair.secretKey
  }

  const logsConfig = require('../archiver-log.json')
  const logDir = `archiver-logs/${config.ARCHIVER_IP}_${config.ARCHIVER_PORT}`
  const baseDir = '.'
  logsConfig.dir = logDir
  Logger.initLogger(baseDir, logsConfig)
  // Initialize storage
  await Storage.initStorage()

  // Initialize state from config
  await State.initFromConfig(config)

  if (State.isFirst === false) {
    Logger.mainLogger.debug(
      'We are not first archiver. Syncing and starting archive-server'
    )
    syncAndStartServer()
  } else {
    Logger.mainLogger.error('This is a bad error')
    Logger.mainLogger.debug('We are first archiver. Starting archive-server')
    io = startServer()
  }
}

async function syncAndStartServer() {
  // If your not the first archiver node, get a nodelist from the others
  let isJoined = false
  let firstTime = true
  let cycleDuration = await Data.getCycleDuration()
  do {
    try {
      // Get active nodes from Archiver
      const nodeList: any = await NodeList.getActiveListFromArchivers(
        State.activeArchivers
      )

      // try to join the network
      isJoined = await Data.joinNetwork(nodeList, firstTime)
    } catch (err) {
      Logger.mainLogger.error('Error while joining network:')
      Logger.mainLogger.error(err)
      Logger.mainLogger.error(err.stack)
      Logger.mainLogger.debug(
        `Trying to join again in ${cycleDuration} seconds...`
      )
      await Utils.sleep(cycleDuration * 1000)
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

  await Data.syncCyclesAndNodeList(State.activeArchivers)

  // Sync all state metadata until no older data is fetched from other archivers
  await Data.syncStateMetaData(
    State.activeArchivers
  )
  // Set randomly selected consensors as dataSender
  let randomConsensor = NodeList.getRandomActiveNode()
  Data.addDataSenders({
    nodeInfo: randomConsensor,
    types: [TypeNames.CYCLE, TypeNames.STATE_METADATA],
  })

  // wait for one cycle before sending data request
  Utils.sleep(cycleDuration * 1000)

  // After we've joined, select a consensus node as a dataSender
  const dataRequest = Crypto.sign({
    dataRequestCycle: Data.createDataRequest<Cycles.Cycle>(
      TypeNames.CYCLE,
      Cycles.getCurrentCycleCounter(),
      randomConsensor.publicKey
    ),
    dataRequestStateMetaData: Data.createDataRequest<StateMetaData>(
      TypeNames.STATE_METADATA,
      Cycles.lastProcessedMetaData,
      randomConsensor.publicKey
    ),
  })
  const newSender: Data.DataSender = {
    nodeInfo: randomConsensor,
    types: [TypeNames.CYCLE, TypeNames.STATE_METADATA],
    contactTimeout: Data.createContactTimeout(randomConsensor.publicKey),
    replaceTimeout: Data.createReplaceTimeout(randomConsensor.publicKey),
  }
  Data.sendDataRequest(newSender, dataRequest)
  Data.initSocketClient(randomConsensor)
  io = startServer()
}

// Define all endpoints, all requests, and start REST server
function startServer() {
  const server: fastify.FastifyInstance<
    Server,
    IncomingMessage,
    ServerResponse
  > = fastify({
    logger: false,
  })

  server.register(fastifyCors)
  server.register(require('fastify-rate-limit'), {
    max: config.RATE_LIMIT,
    timeWindow: 1000,
  })

  // Socket server instance
  io = require('socket.io')(server.server)
  Data.initSocketServer(io)

  // ========== ENDPOINTS ==========

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
  server.post('/nodelist', (request, reply) => {
    const signedFirstNodeInfo: P2P.FirstNodeInfo & Crypto.SignedMessage =
      request.body

    // [TODO] req type guard
    // [TODO] Verify req signature
    try {
        const isSignatureValid = Crypto.verify(signedFirstNodeInfo)
        if (!isSignatureValid) {
            Logger.mainLogger.error("Invalid signature", signedFirstNodeInfo)
            return
        }
    } catch(e) {
        Logger.mainLogger.error(e)
    }
    const ip = signedFirstNodeInfo.nodeInfo.externalIp
    const port = signedFirstNodeInfo.nodeInfo.externalPort
    const publicKey = signedFirstNodeInfo.nodeInfo.publicKey

    if (State.isFirst && NodeList.isEmpty()) {
      const firstNode: NodeList.ConsensusNodeInfo = {
        ip,
        port,
        publicKey,
      }

      Data.initSocketClient(firstNode)

      // Add first node to NodeList
      NodeList.addNodes(NodeStatus.SYNCING, 'bogus', [firstNode])
      // Set first node as dataSender
      Data.addDataSenders({
        nodeInfo: firstNode,
        types: [TypeNames.CYCLE, TypeNames.STATE_METADATA],
        replaceTimeout: Data.createReplaceTimeout(firstNode.publicKey),
      })

      const res = Crypto.sign<P2P.FirstNodeResponse>({
        nodeList: NodeList.getList(),
        joinRequest: P2P.createArchiverJoinRequest(),
        dataRequestCycle: Data.createDataRequest<Cycles.Cycle>(
          TypeNames.CYCLE,
          Cycles.currentCycleCounter,
          publicKey
        ),
        dataRequestStateMetaData: Data.createDataRequest<StateMetaData>(
          TypeNames.STATE_METADATA,
          Cycles.lastProcessedMetaData,
          publicKey
        ),
      })

      reply.send(res)
    } else {
      let nodeList = NodeList.getActiveList()
      // If we dont have any active nodes, send back the first node in our list
      if (nodeList.length < 1) {
        nodeList = NodeList.getList().slice(0, 1)
      }
      const res = Crypto.sign({
        nodeList: nodeList.sort((a: any, b: any) => (a.id > b.id ? 1 : -1)),
      })
      reply.send(res)
    }
  })

  server.get('/nodelist', (_request, reply) => {
    let nodeList = NodeList.getActiveList()
    if (nodeList.length < 1) {
      nodeList = NodeList.getList().slice(0, 1)
    }
    let sortedNodeList = [...nodeList].sort((a: any, b: any) =>
      a.id > b.id ? 1 : -1
    )
    const res = Crypto.sign({
      nodeList: sortedNodeList,
    })
    reply.send(res)
  })

  server.get('/full-nodelist', (_request, reply) => {
    const activeNodeList = NodeList.getActiveList()
    const syncingNodeList = NodeList.getSyncingList()
    const fullNodeList = activeNodeList.concat(syncingNodeList)
    const res = Crypto.sign({
      nodeList: fullNodeList,
    })
    reply.send(res)
  })

  server.get('/full-archive', async (_request, reply) => {
    let err = Utils.validateTypes(_request.query, { start: 's', end: 's' })
    if (err) {
      reply.send(Crypto.sign({ success: false, error: err }))
      return
    }
    let { start, end } = _request.query
    let from = parseInt(start)
    let to = parseInt(end)
    if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
      reply.send(
        Crypto.sign({ success: false, error: `Invalid start and end counters` })
      )
      return
    }
    let count = to - from
    if (count > 100) {
      reply.send(
        Crypto.sign({
          success: false,
          error: `Exceed maximum limit of 100 cycles`,
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

  server.get('/full-archive/:count', async (_request, reply) => {
    let err = Utils.validateTypes(_request.params, { count: 's' })
    if (err) {
      reply.send(Crypto.sign({ success: false, error: err }))
      return
    }

    let count: number = parseInt(_request.params.count)
    if (count <= 0 || Number.isNaN(count)) {
      reply.send(Crypto.sign({ success: false, error: `Invalid count` }))
      return
    }
    if (count > 100) {
      reply.send(Crypto.sign({ success: false, error: `Max count is 100` }))
      return
    }
    const archivedCycles = await Storage.queryAllArchivedCycles(count)
    const res = Crypto.sign({
      archivedCycles,
    })
    reply.send(res)
  })

  server.get('/nodeinfo', (_request, reply) => {
    reply.send({
      publicKey: config.ARCHIVER_PUBLIC_KEY,
      ip: config.ARCHIVER_IP,
      port: config.ARCHIVER_PORT,
      time: Date.now(),
    })
  })

  server.get('/cycleinfo', async (_request, reply) => {
    let err = Utils.validateTypes(_request.query, { start: 's', end: 's' })
    if (err) {
      reply.send(Crypto.sign({ success: false, error: err }))
      return
    }

    let { start, end } = _request.query
    let from = parseInt(start)
    let to = parseInt(end)

    if (!(from >= 0 && to >= from) || Number.isNaN(from) || Number.isNaN(to)) {
      Logger.mainLogger.error(`Invalid start and end counters`)
      reply.send(
        Crypto.sign({ success: false, error: `Invalid start and end counters` })
      )
      return
    }
    let cycleInfo = []
    cycleInfo = await Storage.queryCycleRecordsBetween(from, to)
    const res = Crypto.sign({
      cycleInfo,
    })
    reply.send(res)
  })

  server.get('/cycleinfo/:count', async (_request, reply) => {
    let err = Utils.validateTypes(_request.params, { count: 's' })
    if (err) {
      reply.send(Crypto.sign({ success: false, error: err }))
      return
    }
    let count: number = parseInt(_request.params.count)
    if (count <= 0 || Number.isNaN(count)) {
      reply.send(Crypto.sign({ success: false, error: `Invalid count` }))
      return
    }
    if (count > 100) count = 100 // return max 100 cycles

    let cycleInfo = await Storage.queryLatestCycleRecords(count)
    const res = Crypto.sign({
      cycleInfo,
    })
    reply.send(res)
  })

  server.post('/gossip-hashes', async (_request, reply) => {
    let gossipMessage = _request.body
    Logger.mainLogger.debug('Gossip received', JSON.stringify(gossipMessage))
    addHashesGossip(gossipMessage.sender, gossipMessage.data)
    const res = Crypto.sign({
      success: true,
    })
    reply.send(res)
  })

  // [TODO] Remove this before production
  // server.get('/exit', (_request, reply) => {
  //   reply.send('Shutting down...')
  //   process.exit()
  // })

  // [TODO] Remove this before production
  server.get('/nodeids', (_request, reply) => {
    reply.send(NodeList.byId)
  })

  // Start server and bind to port on all interfaces
  server.listen(config.ARCHIVER_PORT, '0.0.0.0', (err, _address) => {
    Logger.mainLogger.debug('Listening3')
    if (err) {
      server.log.error(err)
      process.exit(1)
    }
    Logger.mainLogger.debug('Archive-server has started.')
    State.addSigListeners()
  })
  return io
}

start()
