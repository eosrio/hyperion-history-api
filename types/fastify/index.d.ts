import {Client} from "@elastic/elasticsearch";
import {Redis} from "ioredis";
import {ConnectionManager} from "../../connections/manager.class";
import {Api, JsonRpc} from "eosjs";

declare module 'fastify' {
	export interface FastifyInstance {
		manager: ConnectionManager;
		redis: Redis;
		elastic: Client;
		eosjs: {
			rpc: JsonRpc;
			api: Api;
		};
		chain_api: string;
		push_api: string;
		tokenCache: Map<string, any>;
		allowedActionQueryParamSet: Set<string>;
	}
}
