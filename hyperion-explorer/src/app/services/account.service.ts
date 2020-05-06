import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {GetAccountResponse} from '../interfaces';
import {MatTableDataSource} from '@angular/material/table';
import {HyperionSocketClient} from '@eosrio/hyperion-stream-client/lib/client/hyperion-socket-client';

interface HealthResponse {
  features: {
    streaming: {
      deltas: boolean;
      enable: boolean;
      traces: boolean;
    }
  }
}

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
  streamClient: HyperionSocketClient;
  public streamClientStatus = false;

  constructor(private httpClient: HttpClient) {
    this.getAccountUrl = environment.hyperionApiUrl + '/v2/state/get_account?account=';
    this.getTxUrl = environment.hyperionApiUrl + '/v2/history/get_transaction?id=';
    this.getBlockUrl = environment.hyperionApiUrl + '/v1/trace_api/get_block';
    this.getKeyUrl = environment.hyperionApiUrl + '/v2/state/get_key_accounts?public_key=';
    this.tableDataSource = new MatTableDataSource([]);
    this.initStreamClient().catch(console.log);
  }

  async initStreamClient() {
    let server = '';
    if (environment.production) {
      server = window.location.origin;
    } else {
      server = environment.hyperionApiUrl;
    }
    try {
      const health = await this.httpClient.get(server + '/v2/health').toPromise() as HealthResponse;
      if (health.features.streaming.enable) {
        this.streamClient = new HyperionSocketClient(server, {async: true});
        this.streamClient.onConnect = () => {
          this.streamClientStatus = this.streamClient.online;
        };
        this.streamClient.onData = async (data: any, ack) => {
          console.log(data.content.act);
          if (data.type === 'action') {
            this.actions.unshift(data.content);
            if (this.actions.length > 20) {
              this.actions.pop();
            }
            this.tableDataSource.data = this.actions;
          }
          ack();
        };
      }
    } catch (e) {
      console.log(e);
    }
  }

  setupRequests() {
    this.streamClient.onConnect = () => {
      this.streamClient.streamActions({
        account: this.account.account_name,
        action: '*',
        contract: '*',
        filters: [],
        read_until: 0,
        start_from: 0
      });
      console.log(this.streamClient);
      this.streamClientStatus = this.streamClient.online;
    };
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
      return true;
    } catch (error) {
      console.log(error);
      this.jsonData = null;
      return false;
    }
  }

  async loadTxData(txId: string) {
    try {
      return await this.httpClient.get(this.getTxUrl + txId).toPromise();
    } catch (error) {
      console.log(error);
      return null;
    }
  }

  async loadBlockData(blockNum: number) {
    try {
      return await this.httpClient.post(this.getBlockUrl, {
        block_num: blockNum
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

  toggleStreaming() {
    if (this.streamClientStatus) {
      this.streamClient.disconnect();
      this.streamClientStatus = false;
    } else {
      this.setupRequests();
      this.streamClient.connect(() => {
        console.log('hyperion streaming client connected!');
      });
    }
  }

  disconnectStream() {
    this.streamClient.disconnect();
    this.streamClient.online = false;
    this.streamClientStatus = false;
  }
}
