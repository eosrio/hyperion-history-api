import {FastifyInstance} from "fastify";

export abstract class HyperionPlugin {
	dynamicContracts: string[] = [];

	abstract addRoutes(server: FastifyInstance): void
}
