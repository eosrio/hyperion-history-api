import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {GetTableByScopeResponse, TableData} from '../interfaces';
import {Router} from '@angular/router';

@Injectable({
  providedIn: 'root'
})
export class SearchService {
  searchAccountUrl: string;

  constructor(private httpClient: HttpClient, private router: Router) {
    this.searchAccountUrl = environment.eosioNodeUrl + '/v1/chain/get_table_by_scope';
  }

  async filterAccountNames(value: string) {

    if (value && value.length > 12) {
      return [];
    }

    const requestBody = {
      code: environment.systemContract,
      table: environment.userResourcesTable,
      lower_bound: value,
      limit: 5
    };

    try {
      const response = await this.httpClient.post(this.searchAccountUrl, requestBody).toPromise() as GetTableByScopeResponse;

      if (response.rows) {
        return response.rows.filter((tableData: TableData) => {
          return tableData.scope.startsWith(value);
        }).map((tableData: TableData) => {
          return tableData.scope;
        });
      }
    } catch (error) {
      console.log(error);
      return [];
    }
  }


  async submitSearch(searchText: any, filteredAccounts: string[]) {

    // tx id
    if (searchText.length === 64) {
      await this.router.navigate(['/transaction', searchText]);
      return true;
    }

    // account
    if (filteredAccounts.length > 0 && searchText.length > 0 && searchText.length <= 12) {
      await this.router.navigate(['/account', searchText]);
      return true;
    }

    // public key
    if (searchText.startsWith('PUB_K1_') || searchText.startsWith('EOS')) {
      await this.router.navigate(['/key', searchText]);
      return true;
    }

    // block number
    const blockNum = searchText.replace(/[,.]/g, '');
    if (parseInt(blockNum, 10) > 0) {
      await this.router.navigate(['/block', blockNum]);
      return true;
    }

    return false;
  }
}
