import type {MongoDbStatefulIndexedAdapterV1} from './stateful-indexed-v1.js';
import {requireState} from './stateful-contract.js';
// Native-internal linkage only. The engineering entry point validates exact assembly bytes
// before selecting this facade; neither a public boolean nor a DTO issues read/owner authority.
const factories = new WeakMap<MongoDbStatefulIndexedAdapterV1, () => MongoDbStatefulIndexedAdapterV1>();
export function registerIndexedEngineeringFacadeV1(adapter: MongoDbStatefulIndexedAdapterV1, factory: () => MongoDbStatefulIndexedAdapterV1): void {
    requireState(!factories.has(adapter),'Engineering indexed facade already registered'); factories.set(adapter,factory);
}
export function indexedEngineeringFacadeV1(adapter: MongoDbStatefulIndexedAdapterV1): MongoDbStatefulIndexedAdapterV1 {
    const factory=factories.get(adapter);requireState(factory,'Engineering assembly requires an actual locally created native indexed adapter');return factory();
}
