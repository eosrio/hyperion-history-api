import {Injectable} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {environment} from '../../environments/environment';
import {GetTableByScopeResponse, TableData} from '../interfaces';

@Injectable({
  providedIn: 'root'
})
export class SearchService {
  searchAccountUrl: string;

  constructor(private httpClient: HttpClient) {
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
    }
  }
}
