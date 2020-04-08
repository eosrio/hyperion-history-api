import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {GetAccountResponse} from '../interfaces';

@Injectable({
  providedIn: 'root'
})
export class AccountService {
  getAccountUrl: string;
  jsonData: any;
  account: any;
  actions: any[];
  tokens: any[];

  constructor(private httpClient: HttpClient) {
    this.getAccountUrl = environment.hyperionApiUrl + '/v2/state/get_account?account=';
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
      }
    } catch (error) {
      console.log(error);
    }
  }
}
