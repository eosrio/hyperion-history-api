export interface GetAccountResponse {
  account: string;
  actions: any[];
  tokens: any[];
  links: any[];
}

export interface TableData {
  code: string;
  scope: string;
  table: string;
  payer: string;
  count: number;
}

export interface GetTableByScopeResponse {
  rows: TableData[];
  more: string;
}

export interface AccountCreationData {
  creator: string;
  timestamp: string;
}
