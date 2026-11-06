# Recorded Mongo qualification feedback input

`mongo-1244.json` is the source-bound input retained by the independent diagnosis of
HAPI #341. The LF-normalized tracked file has SHA256 `615033e1084a3d0cf39cd183887d1f7758004520f542ef8ddad9f49bdd1123b0`.
The original CRLF input has SHA256 `197b40161d5c8b2724426876bff8197fe32555a9b84dc8d0fa1558ef382c0052`; parsed content is identical.

It retains the original 1..1480 checkpoint identities, the actual failed source at block 1244 and
its previous checkpoint 1243, invalid definition/binding, mapping input, earlier detached recovery,
and archive/source/oracle hashes from the frozen 29057aaa Node 26 capture. The original failed
physical sample was not captured and cannot be reconstructed from this file. The historical
interleaving remains unknown.

The red-capable controller/runtime/adapter/auditor loop uses only controlled Mongo transport.
The sampling controls additionally use the existing healthy plan row, actual adapter-produced
metadata and real Fastify route. Cloned baseline documents are isolated transport fixtures.
No source proof, revalidation success, real-server durability, launch pin or qualification
acceptance is supplied by these records. Do not edit source positions or reason predicates to
make a control pass.
