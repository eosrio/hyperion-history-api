/** Resolve only protocol-source storage. Chain identity and history names remain unchanged. */
export function protocolSourceNamespace(chain:string, suffix?:string):string {
    if(suffix===undefined)return chain;
    if(typeof chain!=='string'||!chain.length||chain.length>160||chain.includes('-psrc-')||!/^[a-z0-9][a-z0-9._-]*$/.test(chain))
        throw new Error('Invalid protocol source chain');
    if(typeof suffix!=='string'||!/^[a-z0-9][a-z0-9-]{0,31}$/.test(suffix))throw new Error('Invalid protocol source namespace');
    const namespace=`${chain}-psrc-${suffix}`;
    if(namespace.length>121)throw new Error('Protocol source namespace is too long');
    return namespace;
}
