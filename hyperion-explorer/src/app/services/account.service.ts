import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {GetAccountResponse} from '../interfaces';
import {MatTableDataSource} from "@angular/material/table";

@Injectable({
  providedIn: 'root'
})
export class AccountService {
  getAccountUrl: string;
  getTxUrl: string;
  getBlockUrl: string;
  getKeyUrl: string;
  jsonData: any;
  account: any = {
    cpu_limit: {
      used: 1,
      max: 1
    },
    net_limit: {
      used: 1,
      max: 1
    }
  };
  actions: any[] = [];
  tokens: any[] = [];
  public tableDataSource: MatTableDataSource<any[]>;

  constructor(private httpClient: HttpClient) {
    this.getAccountUrl = environment.hyperionApiUrl + '/v2/state/get_account?account=';
    this.getTxUrl = environment.hyperionApiUrl + '/v2/history/get_transaction?id=';
    this.getBlockUrl = environment.hyperionApiUrl + '/v1/trace_api/get_block';
    this.getKeyUrl = environment.hyperionApiUrl + '/v2/state/get_key_accounts?public_key=';
    this.tableDataSource = new MatTableDataSource([]);
  }

  async loadAccountData(accountName: string) {
    try {
      this.jsonData = await this.httpClient.get(this.getAccountUrl + accountName).toPromise() as GetAccountResponse;

      if (this.jsonData.account) {
        this.account = this.jsonData.account;
      }

      if (this.jsonData.tokens) {
        this.tokens = this.jsonData.tokens;
      }

      if (this.jsonData.actions) {
        this.actions = this.jsonData.actions;
        this.tableDataSource.data = this.actions;
      }
    } catch (error) {
      console.log(error);
    }
  }

  async loadTxData(tx_id: string) {
    try {
      return await this.httpClient.get(this.getTxUrl + tx_id).toPromise();
    } catch (error) {
      console.log(error);
      return null;
    }
  }

  async loadBlockData(block_num: number) {
    try {
      return await this.httpClient.post(this.getBlockUrl, {
        "block_num": block_num
      }).toPromise();
    } catch (error) {
      console.log(error);
      return null;
    }
  }

  async loadPubKey(key: string) {
    try {
      return await this.httpClient.get(this.getKeyUrl + key + '&details=true').toPromise();
    } catch (error) {
      console.log(error);
      return null;
    }
  }
}
