import {Channel, Message} from "amqplib/callback_api";
import {ConnectionManager} from "../connections/manager.class";
import _ from "lodash";
import {hLog} from "./common_functions";
import {createHash} from "crypto";

type MaxBlockCb = (maxBlock: number) => void;
type routerFunction = (blockNum: number) => string;
type MMap = Map<string, any>;

function makeScriptedOp(id, body) {
	return [
		{update: {_id: id, retry_on_conflict: 3}},
		{script: {id: "updateByBlock", params: body}, scripted_upsert: true, upsert: {}}
	];
}

function makeDelOp(id) {
	return [
		{delete: {_id: id}}
	];
}

function flatMap(payloads: Message[], builder) {
	return _(payloads).map((payload: Message) => {
		const body = JSON.parse(payload.content.toString());
		return builder(payload, body);
	}).flatten()['value']();
}

function buildAbiBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const id = body['block'] + body['account'];
		messageMap.set(id, _.omit(payload, ['content']));
		return [{index: {_id: id}}, body];
	});
}

function buildActionBulk(payloads, messageMap: MMap, maxBlockCb: MaxBlockCb, routerFunc: routerFunction, indexName: string) {
	return flatMap(payloads, (payload, body) => {
		const id = body['global_sequence'];
		messageMap.set(id, _.omit(payload, ['content']));
		return [{
			index: {
				_id: id,
				_index: `${indexName}-${routerFunc(body.block_num)}`
			}
		}, body];
	});
}

function buildBlockBulk(payloads, messageMap: MMap, maxBlockCb: MaxBlockCb, routerFunc: routerFunction, indexName: string) {
	return flatMap(payloads, (payload, body) => {
		const id = body['block_num'];
		messageMap.set(id, _.omit(payload, ['content']));
		return [{
			index: {_id: id}
		}, body];
	});
}

function buildDeltaBulk(payloads, messageMap: MMap, maxBlockCb: MaxBlockCb, routerFunc: routerFunction, indexName: string) {
	let maxBlock = 0;
	const flat_map = flatMap(payloads, (payload, b) => {
		delete b.present;
		if (maxBlock < b.block_num) {
			maxBlock = b.block_num;
		}
		const id = `${b.block_num}-${b.code}-${b.scope}-${b.table}-${b.primary_key}`;
		messageMap.set(id, _.omit(payload, ['content']));
		return [{
			index: {
				_id: id,
				_index: `${indexName}-${routerFunc(b.block_num)}`
			}
		}, b];
	});
	maxBlockCb(maxBlock);
	return flat_map;
}

function buildDynamicTableBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		messageMap.set(payload.id, _.omit(payload, ['content']));
		if (payload.present === 0) {
			return makeDelOp(payload.id);
		} else {
			return makeScriptedOp(payload.id, body);
		}
	});
}

function buildTableProposalsBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const id = `${body.proposer}-${body.proposal_name}-${body.primary_key}`;
		messageMap.set(id, _.omit(payload, ['content']));
		return makeScriptedOp(id, body);
	});
}

function buildTableAccountsBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const id = `${body.code}-${body.scope}-${body.symbol}`;
		messageMap.set(id, _.omit(payload, ['content']));
		return makeScriptedOp(id, body);
	});
}

function buildTableVotersBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const id = `${body.voter}`;
		messageMap.set(id, _.omit(payload, ['content']));
		return makeScriptedOp(id, body);
	});
}

function buildLinkBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const id = `${body.account}-${body.permission}-${body.code}-${body.action}`;
		messageMap.set(id, _.omit(payload, ['content']));
		return makeScriptedOp(id, body);
	});
}

function buildPermBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const id = `${body.owner}-${body.name}`;
		messageMap.set(id, _.omit(payload, ['content']));
		return makeScriptedOp(id, body);
	});
}

function buildResLimitBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const id = `${body.owner}`;
		messageMap.set(id, _.omit(payload, ['content']));
		return makeScriptedOp(id, body);
	});
}

function buildResUsageBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const id = `${body.owner}`;
		messageMap.set(id, _.omit(payload, ['content']));
		return makeScriptedOp(id, body);
	});
}

function buildGenTrxBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const hash = createHash('sha256')
			.update(body.sender + body.sender_id + body.payer)
			.digest()
			.toString("hex");
		const id = `${body.block_num}-${hash}`;
		messageMap.set(id, _.omit(payload, ['content']));
		return [{index: {_id: id}}, body];
	});
}

function buildTrxErrBulk(payloads, messageMap: MMap) {
	return flatMap(payloads, (payload, body) => {
		const id = body.trx_id.toLowerCase();
		delete body.trx_id;
		messageMap.set(id, _.omit(payload, ['content']));
		return [{index: {_id: id}}, body];
	});
}

const generatorsMap = {
	permission: {
		index_name: 'perm',
		func: buildPermBulk
	},
	permission_link: {
		index_name: 'link',
		func: buildLinkBulk
	},
	resource_limits: {
		index_name: 'reslimits',
		func: buildResLimitBulk
	},
	resource_usage: {
		index_name: 'userres',
		func: buildResUsageBulk
	},
	generated_transaction: {
		index_name: 'gentrx',
		func: buildGenTrxBulk
	},
	trx_error: {
		index_name: 'trxerr',
		func: buildTrxErrBulk
	},
};

interface IndexDist {
	index: string;
	first_block: number;
	last_block: number;
}

export class ElasticRoutes {
	public routes: any;
	cm: ConnectionManager;
	chain: string;
	ingestNodeCounters = {};
	distributionMap: IndexDist[];

	constructor(connectionManager: ConnectionManager, distributionMap: IndexDist[]) {
		this.distributionMap = distributionMap;
		this.routes = {generic: this.handleGenericRoute.bind(this)};
		this.cm = connectionManager;
		this.chain = this.cm.chain;
		this.registerRoutes();
		this.resetCounters();
	}

	createGenericBuilder(collection, channel, counter, index_name, method) {
		return new Promise((resolve) => {
			const messageMap = new Map();
			let maxBlockNum;
			this.bulkAction({
				index: index_name,
				body: method(collection, messageMap, (maxBlock) => {
					maxBlockNum = maxBlock;
				})
			}).then((resp: any) => {
				if (resp.body.errors) {
					this.ackOrNack(resp, messageMap, channel);
				} else {
					if (maxBlockNum > 0) {
						ElasticRoutes.reportMaxBlock(maxBlockNum, index_name);
					}
					channel.ackAll();
				}
				resolve(messageMap.size);
			}).catch((err) => {
				try {
					channel.nackAll();
					hLog('NackAll', err);
				} finally {
					resolve(0);
				}
			});
		})
	}

	async handleGenericRoute(payload: Message[], ch: Channel, cb: (indexed_size: number) => void): Promise<void> {
		const coll = {};
		for (const message of payload) {
			const type = message.properties.headers.type;
			if (!coll[type]) {
				coll[type] = [];
			}
			coll[type].push(message);
		}

		const queue = [];
		const v = this.cm.config.settings.index_version;
		let counter = 0;

		Object.keys(coll).forEach(value => {
			if (generatorsMap[value]) {
				const indexName = `${this.chain}-${generatorsMap[value].index_name}-${v}`;
				queue.push(this.createGenericBuilder(coll[value], ch, counter, indexName, generatorsMap[value].func));
			}
		});

		await Promise.all(queue);
		cb(counter);
	}

	resetCounters() {
		this.cm.ingestClients.forEach((val, idx) => {
			this.ingestNodeCounters[idx] = {
				status: true,
				docs: 0
			};
		});
	}

	ackOrNack(resp, messageMap, channel: Channel) {
		for (const item of resp.body.items) {
			let id, itemBody;
			if (item['index']) {
				id = item.index._id;
				itemBody = item.index;
			} else if (item['update']) {
				id = item.update._id;
				itemBody = item.update;
			} else if (item['delete']) {
				id = item.delete._id;
				itemBody = item.delete;
			} else {
				console.log(item);
				throw new Error('FATAL ERROR - CANNOT EXTRACT ID');
			}
			const message = messageMap.get(id);
			const status = itemBody.status;
			if (message) {
				switch (status) {
					case 200: {
						channel.ack(message);
						break;
					}
					case 201: {
						channel.ack(message);
						break;
					}
					case 404: {
						channel.ack(message);
						break;
					}
					case 409: {
						console.log(item);
						channel.nack(message);
						break;
					}
					default: {
						console.log(item, message.fields.deliveryTag);
						console.info(`nack id: ${id} - status: ${status}`);
						channel.nack(message);
					}
				}
			} else {
				console.log(item);
				throw new Error('Message not found');
			}
		}
	}

	onResponse(resp, messageMap, callback, payloads, channel: Channel, index_name: string, maxBlockNum: number) {
		if (resp.errors) {
			this.ackOrNack(resp, messageMap, channel);
			if (maxBlockNum > 0) {
				ElasticRoutes.reportMaxBlock(maxBlockNum, index_name);
			}
		} else {
			channel.ackAll();
		}
		callback(messageMap.size);
	}

	onError(err, channel: Channel, callback) {
		try {
			channel.nackAll();
			hLog('NackAll', err);
		} finally {
			callback();
		}
	}

	bulkAction(bulkData) {
		let minIdx = 0;
		if (this.cm.ingestClients.length > 1) {
			let min;
			this.cm.ingestClients.forEach((val, idx) => {
				if (!min) {
					min = this.ingestNodeCounters[idx].docs;
				} else {
					if (this.ingestNodeCounters[idx].docs < min) {
						min = this.ingestNodeCounters[idx].docs;
						minIdx = idx;
					}
				}
			});
		}
		this.ingestNodeCounters[minIdx].docs += bulkData.body.length;
		if (this.ingestNodeCounters[minIdx].docs > 1000) {
			this.resetCounters();
		}
		return this.cm.ingestClients[minIdx]['bulk'](bulkData);
	}

	getIndexPartition(blockNum: number): string {
		return Math.ceil(blockNum / this.cm.config.settings.index_partition_size).toString().padStart(6, '0');
	}

	getIndexNameByBlock(block_num) {
		if (!this.distributionMap) {
			return null;
		}
		for (let i = this.distributionMap.length - 1; i >= 0; i--) {
			const test = this.distributionMap[i].first_block <= block_num && this.distributionMap[i].last_block >= block_num;
			if (test) {
				return this.distributionMap[i].index;
			}
		}
		return null;
	}

	addToIndexMap(map, idx, payload) {
		if (idx) {
			if (!map[idx]) {
				map[idx] = [];
			}
			map[idx].push(payload);
		}
	}

	private routeFactory(indexName: string, bulkGenerator, routerFunction) {
		return async (payloads, channel, cb) => {

			let _index = `${this.chain}-${indexName}-${this.cm.config.settings.index_version}`;

			// write directly to index
			const messageMap = new Map();
			let maxBlockNum;
			this.bulkAction({
				index: _index,
				type: '_doc',
				body: bulkGenerator(payloads, messageMap, (maxBlock) => {
					maxBlockNum = maxBlock;
				}, routerFunction, _index)
			}).then(resp => {
				this.onResponse(resp, messageMap, cb, payloads, channel, _index, maxBlockNum);
			}).catch(err => {
				this.onError(err, channel, cb);
			});

			// if (this.cm.config.indexer.rewrite) {
			//
			// 	// // write to remapped indices
			// 	// let payloadBlock = null;
			// 	// const indexMap = {};
			// 	// let pIdx = null;
			// 	// if (indexName === 'action' || indexName === 'delta') {
			// 	// 	for (const payload of payloads) {
			// 	// 		const blk = payload.properties.headers?.block_num;
			// 	// 		if (!payloadBlock) {
			// 	// 			payloadBlock = blk;
			// 	// 			pIdx = this.getIndexNameByBlock(blk);
			// 	// 			console.log(pIdx);
			// 	// 			this.addToIndexMap(indexMap, pIdx, payload);
			// 	// 		} else {
			// 	// 			const _idx = payloadBlock === blk ? pIdx : this.getIndexNameByBlock(blk);
			// 	// 			console.log(_idx);
			// 	// 			this.addToIndexMap(indexMap, _idx, payload);
			// 	// 		}
			// 	// 	}
			// 	// }
			// 	//
			// 	// // if no index was mapped to that range use the default alias
			// 	// if (Object.keys(indexMap).length === 0) {
			// 	// 	indexMap[_index] = payloads;
			// 	// }
			// 	//
			// 	// const queue = [];
			// 	// let counter = 0;
			// 	//
			// 	// for (const idxKey in indexMap) {
			// 	// 	queue.push(this.createGenericBuilder(indexMap[idxKey], channel, counter, idxKey, bulkGenerator));
			// 	// }
			// 	//
			// 	// const results = await Promise.all(queue);
			// 	// results.forEach(value => counter += value);
			// 	// cb(counter);
			//
			// } else {
			// 	// write directly to index
			// 	const messageMap = new Map();
			// 	let maxBlockNum;
			// 	this.bulkAction({
			// 		index: _index,
			// 		type: '_doc',
			// 		body: bulkGenerator(payloads, messageMap, (maxBlock) => {
			// 			maxBlockNum = maxBlock;
			// 		}, routerFunction, _index)
			// 	}).then(resp => {
			// 		this.onResponse(resp, messageMap, cb, payloads, channel, _index, maxBlockNum);
			// 	}).catch(err => {
			// 		this.onError(err, channel, cb);
			// 	});
			// }
		};
	}

	private addRoute(indexType: string, bulkGenerator, routerFunction) {
		this.routes[indexType] = this.routeFactory(indexType, bulkGenerator, routerFunction);
	}

	private registerRoutes() {
		this.registerDynamicTableRoute();
		const partitionRouter = this.getIndexPartition.bind(this);
		this.addRoute('abi', buildAbiBulk, null);
		this.addRoute('action', buildActionBulk, partitionRouter);
		this.addRoute('block', buildBlockBulk, partitionRouter);
		this.addRoute('delta', buildDeltaBulk, partitionRouter);
		this.addRoute('table-voters', buildTableVotersBulk, null);
		this.addRoute('table-accounts', buildTableAccountsBulk, null);
		this.addRoute('table-proposals', buildTableProposalsBulk, null);
		// this.addRoute('dynamic-table', buildDynamicTableBulk);
	}

	private registerDynamicTableRoute() {
		this.routes['dynamic-table'] = async (payloads, channel, cb) => {
			const contractMap: Map<string, any[]> = new Map();
			let counter = 0;
			for (const payload of payloads) {
				const headers = payload?.properties?.headers;
				const item = {
					id: headers.id,
					block_num: headers.block_num,
					present: headers.present,
					content: payload.content,
					fields: payload.fields,
					properties: payload.properties
				};
				if (contractMap.has(headers.code)) {
					contractMap.get(headers.code).push(item);
				} else {
					contractMap.set(headers.code, [item]);
				}
			}
			const processingQueue = [];
			for (const entry of contractMap.entries()) {
				processingQueue.push(
					this.createGenericBuilder(
						entry[1],
						channel,
						counter,
						`${this.chain}-dt-${entry[0]}`,
						buildDynamicTableBulk
					)
				);
			}
			const results = await Promise.all(processingQueue);
			results.forEach(value => counter += value);
			cb(counter);
		};
	}

	private static reportMaxBlock(maxBlockNum: number, index_name: string) {
		process.send({
			event: 'ingestor_block_report',
			index: index_name,
			proc: process.env.worker_role,
			block_num: maxBlockNum
		});
	}
}
