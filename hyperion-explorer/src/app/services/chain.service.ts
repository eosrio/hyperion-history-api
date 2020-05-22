import {Injectable} from '@angular/core';
import {environment} from '../../environments/environment';
import {HttpClient} from '@angular/common/http';
import {Title} from '@angular/platform-browser';

@Injectable({
  providedIn: 'root'
})
export class ChainService {
  chainInfoData: any = {};

  constructor(private http: HttpClient, private title: Title) {
    this.loadChainData().catch(console.log);
  }

  async loadChainData() {
    try {
      this.chainInfoData = await this.http.get(environment.hyperionApiUrl + '/v2/explorer_metadata').toPromise();
      if (this.chainInfoData.chain_name) {
        this.title.setTitle(`${this.chainInfoData.chain_name} Hyperion Explorer`);
      }
    } catch (error) {
      console.log(error);
    }
  }
}
