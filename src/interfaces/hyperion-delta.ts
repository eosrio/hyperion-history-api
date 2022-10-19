export interface HyperionDelta {
	'@timestamp': string;
	code: string;
	scope: string;
	table: string;
	primary_key: string;
	payer: string;
	present: boolean | number;
	block_num: number;
	block_id: string;
	data: any;
}
