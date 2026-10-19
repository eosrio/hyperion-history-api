These exact protocol and result bytes were captured from the pinned Spring 1.2.2
image on the disposable known-genesis qualification chain on 2026-10-19. They
exercise a valid genesis result with `prev_block: null`, no transaction traces,
an empty signed block and the zero previous block hash. They are a decoder
regression fixture, not a complete replay capture or benchmark result.

The chain ID is
`d8b73ada6b0ff982b5bafed1cde4d7612cc778ff82206c3b67d31a134f95be6c`.
The expected genesis block ID is
`000000014f6c4bbe621c19e0028a671ab0093936ec07ef31365e58a119852628`.
The decoder independently recomputes this ID from the full signed block.
