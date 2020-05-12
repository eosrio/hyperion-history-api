import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {GetAccountResponse} from '../interfaces';
import {MatTableDataSource} from '@angular/material/table';
import {HyperionSocketClient} from '@eosrio/hyperion-stream-client/lib/client/hyperion-socket-client';
import {IncomingData} from '@eosrio/hyperion-stream-client/lib';

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
  public libNum: any;
  private server: string;
  private verificationLoop: any;
  private predictionLoop: any;
  private pendingSet = new Set();
  public loaded = false;

  constructor(private httpClient: HttpClient) {
    this.getServerUrl();
    this.getAccountUrl = environment.hyperionApiUrl + '/v2/state/get_account?account=';
    this.getTxUrl = environment.hyperionApiUrl + '/v2/history/get_transaction?id=';
    this.getBlockUrl = environment.hyperionApiUrl + '/v1/trace_api/get_block';
    this.getKeyUrl = environment.hyperionApiUrl + '/v2/state/get_key_accounts?public_key=';
    this.tableDataSource = new MatTableDataSource([]);
    this.initStreamClient().catch(console.log);
  }

  async monitorLib() {
    console.log('Starting LIB monitoring...');

    if (!this.verificationLoop) {
      this.verificationLoop = setInterval(async () => {
        await this.updateLib();
      }, 21 * 12 * 500);
    }

    if (!this.predictionLoop) {
      this.predictionLoop = setInterval(() => {
        this.libNum += 12;
        if (this.pendingSet.size > 0) {
          this.pendingSet.forEach(async (value) => {
            if (value < this.libNum) {
              console.log(`Block cleared ${value} < ${this.libNum}`);
              this.pendingSet.delete(value);
            }
          });
        } else {
          console.log('No more pending actions, clearing loops');
          this.clearLoops();
        }
      }, 12 * 500);
    }

  }

  async checkIrreversibility() {
    this.libNum = await this.checkLib();
    if (this.libNum) {
      let counter = 0;
      for (const action of this.actions) {
        if (action.block_num <= this.libNum) {
          action.irreversible = true;
        } else {
          counter++;
          this.pendingSet.add(action.block_num);
        }
      }
      if (counter > 0) {
        console.log('Pending actions: ' + counter);
        this.monitorLib().catch(console.log);
      }
    }
  }

  getServerUrl() {
    let server = '';
    if (environment.production) {
      server = window.location.origin;
    } else {
      server = environment.hyperionApiUrl;
    }
    this.server = server;
  }

  async updateLib() {
    this.libNum = await this.checkLib();
  }

  async checkLib(): Promise<number> {
    try {
      const info = await this.httpClient.get(this.server + '/v1/chain/get_info').toPromise() as any;
      if (info) {
        return info.last_irreversible_block_num;
      } else {
        return null;
      }
    } catch (e) {
      console.log(e);
      return null;
    }
  }

  async initStreamClient() {
    try {
      const health = await this.httpClient.get(this.server + '/v2/health').toPromise() as HealthResponse;
      if (health.features.streaming.enable) {
        this.streamClient = new HyperionSocketClient(this.server, {async: true});

        this.streamClient.onConnect = () => {
          this.streamClientStatus = this.streamClient.online;
        };

        this.streamClient.onLIB = (data) => {
          this.libNum = data.block_num;
        };

        this.streamClient.onData = async (data: IncomingData, ack) => {
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
    // find latest block
    let maxBlock = 0;
    for (const action of this.actions) {
      if (action.block_num > maxBlock) {
        maxBlock = action.block_num;
      }
    }

    console.log(maxBlock);

    // setup request
    this.streamClient.onConnect = () => {
      this.streamClient.streamActions({
        account: this.account.account_name,
        action: '*',
        contract: '*',
        filters: [],
        read_until: 0,
        start_from: maxBlock + 1
      });
      this.streamClientStatus = this.streamClient.online;
    };
  }

  async loadAccountData(accountName: string) {
    this.loaded = false;
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
        this.checkIrreversibility().catch(console.log);
        this.tableDataSource.data = this.actions;
      }
      this.loaded = true;
      return true;
    } catch (error) {
      console.log(error);
      this.jsonData = null;
      return false;
    }
  }

  async loadTxData(txId: string) {
    this.loaded = false;
    try {
      const data = await this.httpClient.get(this.getTxUrl + txId).toPromise();
      this.loaded = true;
      return data;
    } catch (error) {
      console.log(error);
      return null;
    }
  }

  async loadBlockData(blockNum: number) {
    this.loaded = false;
    try {
      const data = await this.httpClient.post(this.getBlockUrl, {
        block_num: blockNum
      }).toPromise();
      this.loaded = true;
      return data;
    } catch (error) {
      console.log(error);
      return null;
    }
  }

  async loadPubKey(key: string) {
    this.loaded = false;
    try {
      const data = await this.httpClient.get(this.getKeyUrl + key + '&details=true').toPromise();
      this.loaded = true;
      return data;
    } catch (error) {
      console.log(error);
      return null;
    }
  }

  toggleStreaming() {
    if (this.streamClientStatus) {
      this.streamClient.disconnect();
      this.streamClientStatus = false;
      this.checkIrreversibility().catch(console.log);
    } else {
      this.clearLoops();
      this.setupRequests();
      this.streamClient.connect(() => {
        console.log('hyperion streaming client connected!');
      });
    }
  }

  clearLoops() {
    if (this.predictionLoop) {
      clearInterval(this.predictionLoop);
    }
    if (this.verificationLoop) {
      clearInterval(this.verificationLoop);
    }
  }

  disconnectStream() {
    if (this.streamClient && this.streamClientStatus) {
      this.streamClient.disconnect();
      this.streamClient.online = false;
      this.streamClientStatus = false;
    }
  }
}
