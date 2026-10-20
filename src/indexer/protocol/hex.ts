/** Even-length byte text; avoid repeated-pair regex engine limits on large retained captures. */
export function isProtocolHex(input:unknown,allowUppercase=false):input is string {
    return typeof input==='string'&&input.length%2===0&&(allowUppercase?/^[0-9a-fA-F]*$/:/^[0-9a-f]*$/).test(input);
}
