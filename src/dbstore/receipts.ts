import { Signature } from 'shardus-crypto-types';
import * as db from './sqlite3storage';
import { extractValues } from './sqlite3storage';
import * as Logger from '../Logger'
import { config } from '../Config'

export interface Receipt {
    receiptId: string,
    tx: any,
    cycle: number,
    timestamp: number,
    result: any,
    accounts: any[]
    sign: Signature
}

export async function insertReceipt(receipt: Receipt) {
    try {
        const fields = Object.keys(receipt).join(', ');
        const placeholders = Object.keys(receipt).fill('?').join(', ');
        const values = extractValues(receipt);
        let sql =
            'INSERT OR REPLACE INTO receipts (' +
            fields +
            ') VALUES (' +
            placeholders +
            ')';
        await db.run(sql, values);
        if (config.VERBOSE) {
            Logger.mainLogger.debug(
                'Successfully inserted Receipt', receipt.receiptId
            );
        }
    } catch (e) {
        Logger.mainLogger.error(e);
        Logger.mainLogger.error(
            'Unable to insert Receipt or it is already stored in to database',
            receipt.receiptId
        );
    }
}

export async function queryReceiptByReceiptId(receiptId: string) {
    try {
        const sql = `SELECT * FROM receipts WHERE receiptId=?`;
        let receipt: any = await db.get(sql, [receiptId]);
        if (receipt) {
            if (receipt.tx)
                receipt.tx = JSON.parse(receipt.tx);
            if (receipt.accounts)
                receipt.accounts = JSON.parse(receipt.accounts);
            if (receipt.result)
                receipt.result = JSON.parse(receipt.result);
            if (receipt.sign)
                receipt.sign = JSON.parse(receipt.sign);
        }
        if (config.VERBOSE) {
            Logger.mainLogger.debug('Receipt receiptId', receipt);
        }
        return receipt;
    } catch (e) {
        Logger.mainLogger.error(e);
    }
}

export async function queryLatestReceipts(count) {
    try {
        const sql = `SELECT * FROM receipts ORDER BY cycle DESC, timestamp DESC LIMIT ${count ? count : 100}`;
        const receipts: any = await db.all(sql);
        if (receipts.length > 0) {
            receipts.map((receipt: any) => {
                if (receipt.tx)
                    receipt.tx = JSON.parse(receipt.tx);
                if (receipt.accounts)
                    receipt.accounts = JSON.parse(receipt.accounts);
                if (receipt.result)
                    receipt.result = JSON.parse(receipt.result);
                if (receipt.sign)
                    receipt.sign = JSON.parse(receipt.sign);
                return receipt;
            });
        }
        if (config.VERBOSE) {
            Logger.mainLogger.debug('Receipt latest', receipts);
        }
        return receipts;
    } catch (e) {
        Logger.mainLogger.error(e);
    }
}


export async function queryReceipts(skip = 0, limit = 10000) {
    let receipts
    try {
        const sql = `SELECT * FROM receipts ORDER BY cycle ASC, timestamp ASC LIMIT ${limit} OFFSET ${skip}`
        receipts = await db.all(sql)
        if (receipts.length > 0) {
            receipts.map((receipt: any) => {
                if (receipt.tx)
                    receipt.tx = JSON.parse(receipt.tx);
                if (receipt.accounts)
                    receipt.accounts = JSON.parse(receipt.accounts);
                if (receipt.result)
                    receipt.result = JSON.parse(receipt.result);
                if (receipt.sign)
                    receipt.sign = JSON.parse(receipt.sign);
                return receipt;
            });
        }
    } catch (e) {
        Logger.mainLogger.error(e)
    }
    if (config.VERBOSE) {
        Logger.mainLogger.debug('Receipt receipts', receipts ? receipts.length : receipts, 'skip', skip)
    }
    return receipts
}

export async function queryReceiptCount() {
    let receipts;
    try {
        const sql = `SELECT COUNT(*) FROM receipts`;
        receipts = await db.get(sql, []);
    } catch (e) {
        Logger.mainLogger.error(e);
    }
    if (config.VERBOSE) {
        Logger.mainLogger.debug('Receipt count', receipts);
    }
    if (receipts) receipts = receipts['COUNT(*)'];
    else receipts = 0;
    return receipts;
}