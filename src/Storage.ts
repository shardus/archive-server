import { CycleChain, Cycle  } from './Data/Cycles'
import { config } from './Config'
import knex = require('knex')
import { socketServer } from './Data/Data'
import { Database, FS_Persistence_Adapter, BaseModel } from 'tydb'
import * as Crypto from './Crypto'
import * as Logger from './Logger'
import { StateData, Receipt, Summary, ReceiptMapResult, SummaryBlob  } from './shared-types/State'
import { CycleMarker } from './shared-types/Cycle/CycleCreatorTypes'

export let Collection: any

export class ArchivedCycle extends BaseModel {
  cycleRecord!: Cycle
  cycleMarker!: CycleMarker
  data!: StateData
  receipt!: Receipt
  summary!: Summary
}

export const initStorage = async () => {
  Collection = new Database<ArchivedCycle>({
    ref: config.ARCHIVER_DB,
    model: ArchivedCycle,
    persistence_adapter: FS_Persistence_Adapter,
    autoCompaction: 10 * 30 * 1000, // database compaction every 10 cycles
  })
  await Collection.createIndex({ fieldName: 'cycleMarker', unique: true })
}

export async function insertArchivedCycle(archivedCycle: any) {
  Logger.mainLogger.debug('Inserting archived cycle', archivedCycle.cycleRecord.counter, archivedCycle.cycleMarker)
  try {
    await Collection.insert([ArchivedCycle.new(archivedCycle)])
    Logger.mainLogger.debug('Successfully inserted archivedCycle', archivedCycle.cycleRecord.counter)
    let updatedArchivedCycle = await Collection.find({
      filter: { cycleMarker: archivedCycle.cycleMarker },
    })
    let signedDataToSend = Crypto.sign({
      archivedCycles: updatedArchivedCycle
    })
    if (updatedArchivedCycle) {
      if(socketServer) socketServer.emit('ARCHIVED_CYCLE', signedDataToSend)
    }
  } catch (e) {
    Logger.mainLogger.error(e)
    Logger.mainLogger.error('Unable to insert archive cycle or it is already stored in to database', archivedCycle.cycleRecord.counter, archivedCycle.cycleMarker)
  }
}

export async function updateReceiptMap (
  receiptMapResult: ReceiptMapResult
) {
  if (!receiptMapResult) return
  try {
    let parentCycle = CycleChain.get(receiptMapResult.cycle)

    if (!parentCycle) {
      Logger.mainLogger.error(
        'Unable find record with parent cycle with counter',
        receiptMapResult.cycle
      )
      return
    }

    const existingArchivedCycle = await queryArchivedCycleByMarker(
      parentCycle.marker
    )

    if (!existingArchivedCycle) {
      Logger.mainLogger.error(
        'Unable find existing archived cycle with marker',
        parentCycle.marker
      )
      return
    }

    let newPartitionMaps: any = {}
    if (
      existingArchivedCycle.receipt &&
      existingArchivedCycle.receipt.partitionMaps
    ) {
      newPartitionMaps = { ...existingArchivedCycle.receipt.partitionMaps }
    }

    newPartitionMaps[receiptMapResult.partition] = receiptMapResult.receiptMap

    await Collection.update({
      filter: { cycleMarker: parentCycle.marker },
      update: { $set: { 'receipt.partitionMaps': newPartitionMaps } },
    })
    let updatedArchivedCycle = await Collection.find({
      filter: { cycleMarker: parentCycle.marker },
    })
    let signedDataToSend = Crypto.sign({
      archivedCycles: updatedArchivedCycle
    })
    if (updatedArchivedCycle) {
      if(socketServer) socketServer.emit('ARCHIVED_CYCLE', signedDataToSend)
    }
  } catch (e) {
    Logger.mainLogger.error('Unable to update receipt maps in archived cycle')
    Logger.mainLogger.error(e)
  }
}

export async function updateSummaryBlob (
  summaryBlob: SummaryBlob,
  cycle: number
) {
  if (!summaryBlob) return
  try {
    let parentCycle = CycleChain.get(cycle)

    if (!parentCycle) {
      Logger.mainLogger.error('Unable find record with parent cycle with counter', cycle)
      return
    }

    const existingArchivedCycle = await queryArchivedCycleByMarker(
      parentCycle.marker
    )

    if (!existingArchivedCycle) {
      Logger.mainLogger.error(
        'Unable find existing archived cycle with marker',
        parentCycle.marker
      )
      return
    }

    let newPartitionBlobs: any = {}
    if (
      existingArchivedCycle.summary &&
      existingArchivedCycle.summary.partitionBlobs
    ) {
      newPartitionBlobs = { ...existingArchivedCycle.summary.partitionBlobs }
    }

    newPartitionBlobs[summaryBlob.partition] = summaryBlob

    await Collection.update({
      filter: { cycleMarker: parentCycle.marker },
      update: { $set: { 'summary.partitionBlobs': newPartitionBlobs } },
    })
    let updatedArchivedCycle = await Collection.find({
      filter: { cycleMarker: parentCycle.marker },
    })
    let signedDataToSend = Crypto.sign({
      archivedCycles: updatedArchivedCycle
    })
    if (updatedArchivedCycle) {
      if(socketServer) socketServer.emit('ARCHIVED_CYCLE', signedDataToSend)
    }
   } catch (e) {
    Logger.mainLogger.error('Unable to update summary blobs in archived cycle')
    Logger.mainLogger.error(e)
  }
}

export async function updateArchivedCycle(marker: string, field: string, data: any) {
  let updateObj: any = {}
  updateObj[field] = data
  await Collection.update({
    filter: { cycleMarker: marker },
    update: { $set: updateObj },
  })
  let updatedArchivedCycle = await Collection.find({
    filter: { cycleMarker: marker },
  })
  let signedDataToSend = Crypto.sign({
    archivedCycles: updatedArchivedCycle
  })
  if (updatedArchivedCycle) {
    if(socketServer) socketServer.emit('ARCHIVED_CYCLE', signedDataToSend)
  }
}

export async function queryAllArchivedCycles (count?: number) {
  let archivedCycles = await Collection.find({
    filter: {},
    sort: {
      'cycleRecord.counter': -1,
    },
    limit: count ? count : null,
    project: {
      _id: 0,
    },
  })
  return archivedCycles
}

export async function queryAllArchivedCyclesBetween (start: number, end: number) {
  let archivedCycles = await Collection.find({
    filter: {
      $and: [
        { 'cycleRecord.counter': { $gte: start } },
        { 'cycleRecord.counter': { $lte: end } },
      ],
    },
    sort: {
      'cycleRecord.counter': -1,
    },
    limit: 100,
    project: {
      _id: 0,
    },
  })

  return archivedCycles
}

export async function queryAllCycleRecords () {
  let cycleRecords = await Collection.find({
    filter: {},
    sort: {
      'cycleRecord.counter': -1,
    },
    project: {
      _id: 0,
      cycleMarker: 0,
      receipt: 0,
      data: 0,
      summary: 0,
    },
  })
  return cycleRecords.map((item: any) => item.cycleRecord)
}

export async function queryLatestCycleRecords (count: number = 1) {
  let cycleRecords = await Collection.find({
    filter: {},
    sort: {
      'cycleRecord.counter': -1,
    },
    limit: count,
    project: {
      _id: 0,
      cycleMarker: 0,
      receipt: 0,
      data: 0,
      summary: 0,
    },
  })
  return cycleRecords.map((item: any) => item.cycleRecord)
}

export async function queryTxBlobs() {
  const summaries = await Collection.find({
    filter: {},
    sort: {
      'cycleRecord.counter': -1,
    },
    project: {
      _id: 0,
      cycleMarker: 0,
      receipt: 0,
      data: 0,
      cycleRecord: 0,
    },
  });
  const blobsForEachCycle = summaries
    .filter((s: any) => s.summary)
    .map((s: any) => s.summary.partitionBlobs);
  const txBlobs = [];
  for (const blobByCycle of blobsForEachCycle) {
    const blobs: any = Object.values(blobByCycle);
    for (const b of blobs) {
      if (b.opaqueBlob.totalTx) {
        txBlobs.push({
          latestCycle: b.latestCycle,
          partition: b.partition,
          totalTx: b.opaqueBlob.totalTx,
          txByType: b.opaqueBlob.txByType,
        });
      }
    }
  }
  return txBlobs;
}

export async function queryDataBlobs() {
  const summaries = await Collection.find({
    filter: {},
    limit: 10,
    sort: {
      'cycleRecord.counter': -1,
    },
    project: {
      _id: 0,
      cycleMarker: 0,
      receipt: 0,
      data: 0,
    },
  });
  const blobsForEachCycle = summaries
    .filter((s: any) => s.summary)
    .map((s: any) => s.summary.partitionBlobs);
  const blobsForLatestCycle = blobsForEachCycle[0];
  const dataBlobs = [];
  const blobs: any = Object.values(blobsForLatestCycle);
  for (const b of blobs) {
    if (b.opaqueBlob.totalAccounts) {
      dataBlobs.push({
        latestCycle: b.latestCycle,
        partition: b.partition,
        totalAccounts: b.opaqueBlob.totalAccounts,
        totalBalance: b.opaqueBlob.totalBalance,
        accByType: b.opaqueBlob.accByType,
      });
    }
  }
  return dataBlobs;
}

export async function queryCycleRecordsBetween (start: number, end: number) {
  let cycleRecords = await Collection.find({
    filter: {
      $and: [
        { 'cycleRecord.counter': { $gte: start } },
        { 'cycleRecord.counter': { $lte: end } },
      ],
    },
    sort: {
      'cycleRecord.counter': -1,
    },
  })
  return cycleRecords.map((item: any) => item.cycleRecord)
}


export async function queryArchivedCycleByMarker (marker: string) {
  let archivedCycles = await Collection.find({
    filter: { cycleMarker: marker },
  })
  if (archivedCycles.length > 0) return archivedCycles[0]
}


export async function queryArchivedCycleByCounter(counter: number) {
  const archivedCycles = await Collection.find({
    filter: {'cycleRecord.counter': counter},
  });
  if (archivedCycles.length > 0) return archivedCycles[0];
}

export const queryCyclesByTimestamp = async (timestamp: number) => {
  //TODO need to limit 1
  const data = await Collection.find({
    filter: {'cycleRecord.start': {$lte: timestamp}},
    sort: {
      'cycleRecord.counter': -1,
    },
  });
  if (data.length > 0) return data[0];
};

export async function queryTransactions(offset = 0, limit = 10) {
  let archivedCycles = await Collection.find({
    filter: {},
    sort: {
      'cycleRecord.counter': -1,
    },
    project: {
      _id: 0,
      cycleMarker: 0,
      data: 0,
      summary: 0,
    },
  });
  const txsById: any = {};
  const allTxs = [];
  let skip = 0;
  const skipTxs: string[] = [];
  archivedCycles = archivedCycles.filter((r: any) => r.receipt);
  for (const eachArchivedCycle of archivedCycles) {
    for (const partition in eachArchivedCycle.receipt.partitionMaps) {
      const receiptsInPartition =
        eachArchivedCycle.receipt.partitionMaps[partition];
      for (const txId in receiptsInPartition) {
        const txObj = {
          txId,
          status: receiptsInPartition[txId],
          cycle: eachArchivedCycle.cycleRecord.counter,
          partition,
        };
        if (offset && skip < offset) {
          if (!skipTxs.includes(txId)) {
            skipTxs.push(txId);
            skip += 1;
          }
          continue;
        }
        if (skipTxs.includes(txId)) break;
        if (txsById[txId]) {
          txsById[txId].push(txObj);
        }
        if (allTxs.length >= limit) break;
        if (!txsById[txId]) {
          allTxs.push(txObj);
          txsById[txId] = [txObj];
        }
      }
    }
  }
  return {txsById, allTxs};
}

export async function queryTransactionById(txId: string) {
  let archivedCycles = await Collection.find({
    filter: {},
    sort: {
      'cycleRecord.counter': -1,
    },
    project: {
      _id: 0,
      cycleMarker: 0,
      data: 0,
      summary: 0,
    },
  });
  archivedCycles = archivedCycles.filter((r: any) => r.receipt);
  for (const eachArchivedCycle of archivedCycles) {
    for (const partition in eachArchivedCycle.receipt.partitionMaps) {
      const receiptsInPartition =
        eachArchivedCycle.receipt.partitionMaps[partition];
      if (receiptsInPartition[txId]) {
        return {
          txId,
          status: receiptsInPartition[txId],
          cycle: eachArchivedCycle.cycleRecord.counter,
          partition,
        };
      }
    }
  }
  return null;
}

export async function queryReceiptMapHash (counter: number, partition: number) {
  let foundArchivedCycles = await Collection.find({
    filter: { 'cycleRecord.counter': counter },
  })
  if (foundArchivedCycles.length > 0) {
    if (foundArchivedCycles[0].receipt && foundArchivedCycles[0].receipt.partitionHashes) {
      return foundArchivedCycles[0].receipt.partitionHashes[partition]
    }
  }
}

export async function querySummaryHash (counter: number, partition: number) {
  let foundArchivedCycles = await Collection.find({
    filter: { 'cycleRecord.counter': counter },
  })
  if (foundArchivedCycles.length > 0) {
    if (foundArchivedCycles[0].summary && foundArchivedCycles[0].summary.partitionHashes) {
      return foundArchivedCycles[0].summary.partitionHashes[partition]
    }
  }
}
