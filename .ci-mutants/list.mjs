// Inline-record mutants: [name, file, exact original text, replacement].
const S='src/indexer/protocol/immutable-bundle-store.ts',F='src/indexer/protocol/abi-frontier-store.ts';
const conflict=name=>'throw new Error(`Immutable ABI observation conflict: ${'+name+'}`);';
const chunkBlock=`        if (storedChunk?.found) {
            if (canonical(storedChunk._source) !== canonical(chunk)) ${conflict('chunkId')}
            if (!await this.writeIdentical(chunkId, chunk, storedChunk, signal)) await this.createImmutable(chunkId, chunk, signal);
        } else await this.createImmutable(chunkId, chunk, signal);
`;
export const mutants=[
['receipt: inline create accepts an incomplete receipt',S,`document: inline, refresh: false,
                    wait_for_active_shards: 'all', pipeline: '_none'}, {signal}));
                this.assertWrite(response, id, 'created');`,`document: inline, refresh: false,
                    wait_for_active_shards: 'all', pipeline: '_none'}, {signal}));`],
['form: a two-document record is rewritten inline',S,`        return this.writeIdentical(id, twoDocuments, existing, signal);`,`        return this.writeIdentical(id, inline, existing, signal);`],
['receipt: a two-document chunk is not reasserted',S,chunkBlock,``],
['order: a two-document manifest before its chunk',S,chunkBlock+`        return this.writeIdentical(id, twoDocuments, existing, signal);`,
`        const done = await this.writeIdentical(id, twoDocuments, existing, signal);
`+chunkBlock+`        return done;`],
['conflict: different bytes accepted',S,`        if (found !== canonical(twoDocuments)) ${conflict('id')}`,`        if (found !== canonical(twoDocuments)) return true;`],
['conflict: a changed stored chunk accepted',S,`            if (canonical(storedChunk._source) !== canonical(chunk)) ${conflict('chunkId')}
            if (!await this.writeIdentical(chunkId, chunk, storedChunk, signal))`,`            if (!await this.writeIdentical(chunkId, chunk, storedChunk, signal))`],
['form: a manifest with both forms accepted',S,`(inline ? Object.hasOwn(manifest, 'chunk_ids') || Object.hasOwn(manifest, 'chunk_index') || typeof`,`(inline ? typeof`],
['form: an inline payload over one chunk accepted',S,`                    || manifest.byte_length > this.bounds.chunkBytes || manifest.payload.length`,`                    || manifest.payload.length`],
['staged read: no room reserved for inline payloads',S,`this.options.inlineSingleChunk === true ? Math.ceil(this.bounds.chunkBytes / 3) * 4 : 0`,`0`],
['write: the frontier stops writing inline',F,`inlineSingleChunk:true});`,`inlineSingleChunk:false});`],
['default: inline skips the opening check',S,`        } else if (expected !== 'absent') await this.assertManifestUnchanged(id, [inline, twoDocuments], signal);`,`        }`],
['repair: a lost two-document chunk is not restored',S,`        } else await this.createImmutable(chunkId, chunk, signal);
        return this.writeIdentical(id, twoDocuments, existing, signal);`,`        }
        return this.writeIdentical(id, twoDocuments, existing, signal);`],
['race: a lost inline write treated as done',S,`            if (await this.reassertExisting(id, await this.get(id, signal), inline, twoDocuments, chunkId, chunk, signal)) return;`,
`            await this.reassertExisting(id, await this.get(id, signal), inline, twoDocuments, chunkId, chunk, signal); return;`],
['readback: an inline readback takes the ordered read',S,`        if(manifest.payload!==undefined){const payload=this.decodeInline(id,manifest);return {manifest,payloads:[payload],bytes:payload.length};}
        if(!storedChunk!.found`,`        if(!storedChunk!.found`],
['integrity: inline payload re-encoding not checked',S,`        if (payload.toString('base64') !== manifest.payload || payload.length !== manifest.byte_length)`,`        if (payload.length !== manifest.byte_length)`],
];
