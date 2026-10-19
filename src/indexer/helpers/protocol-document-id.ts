import {createHash} from 'node:crypto';

const hex64 = /^[0-9a-f]{64}$/;
const componentId = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]{0,127}$/;
const uint32 = (value: unknown, minimum = 0): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= minimum && value <= 0xffffffff;
const text = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && !/[\ud800-\udfff]/u.test(value);

/** Unambiguous UTF-8 framing, shared with future history writers in other languages. */
function digest(parts: readonly string[]): string {
    const hash = createHash('sha256');
    const length = Buffer.alloc(8);
    for (const part of parts) {
        length.writeBigUInt64BE(BigInt(Buffer.byteLength(part, 'utf8')));
        hash.update(length);
        hash.update(part, 'utf8');
    }
    return hash.digest('hex');
}

/** Opaque bounded key for new protocol records; the complete logical key remains in _source. */
export function protocolStateKey(id: string, chainId: string, logicalIdentity: string): string {
    if (!text(id) || id.length > 214 || !componentId.test(id) || !text(chainId) || !hex64.test(chainId) || !text(logicalIdentity)) {
        throw new Error('Invalid protocol record identity');
    }
    return 'h45k1:' + digest(['hyperion-state-key-v1', id, chainId, logicalIdentity]);
}

/** Legacy records deliberately retain their existing ID and primary_key policy. */
export function protocolDocumentIds(body: any): {documentId: string; primaryKey: string} | undefined {
    if (body.protocol === undefined) return undefined;
    const protocol = body.protocol;
    const source = protocol?.source;
    if (!protocol || !text(protocol.id) || protocol.id.length > 214 || !componentId.test(protocol.id) || !text(protocol.logicalIdentity)
        || !source || !text(source.chainId) || !hex64.test(source.chainId) || !text(source.blockId) || !hex64.test(source.blockId)
        || !uint32(source.blockNum, 1) || !uint32(source.ordinal) || !text(source.abiDeployment)
        || body.block_num !== source.blockNum || body.block_id !== source.blockId) {
        throw new Error('Invalid protocol history identity or source position');
    }
    const primaryKey = protocolStateKey(protocol.id, source.chainId, protocol.logicalIdentity);
    const documentId = 'h45h1:' + digest(['hyperion-history-document-v1', protocol.id, source.chainId,
        protocol.logicalIdentity, source.blockId, String(source.blockNum), String(source.ordinal)]);
    return {documentId, primaryKey};
}
