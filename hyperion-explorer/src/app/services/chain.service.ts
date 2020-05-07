import {Injectable} from '@angular/core';
import {environment} from '../../environments/environment';
import {HttpClient} from '@angular/common/http';

@Injectable({
  providedIn: 'root'
})
export class ChainService {
  chainInfoData: any = {};

  constructor(private http: HttpClient) {
    this.loadChainData().catch(console.log);
  }

  async loadChainData() {
    try {
      this.chainInfoData = await this.http.get(environment.hyperionApiUrl + '/v2/explorer_metadata').toPromise();
    } catch (error) {
      console.log(error);
    }
  }
}
