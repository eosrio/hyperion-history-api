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

export interface BasicDelta {
	code: string;
	table: string;
	scope: string;
	primary_key: string;
	payer: string;
}
