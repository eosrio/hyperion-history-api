import {Component} from '@angular/core';
import {HttpClient} from '@angular/common/http';
import {ActivatedRoute} from '@angular/router';

import * as Hyperion from 'hyperion-stream-client';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.css']
})
export class AppComponent {
  baseUrl = 'https://daobet.eosrio.io';
  jsonData: any;
  account: string;
  actions: any[];
  tokens: any[];
  accountData: any;

  constructor(private http: HttpClient, private route: ActivatedRoute) {
    if (window.location.hostname !== 'localhost') {
      this.baseUrl = 'https://' + window.location.hostname;
    }
    this.route.queryParams.subscribe(params => {
      console.log(params);
      if (params.account) {
        this.account = params.account;
        this.getAccountData(this.account);
      }
    });
    const client = new Hyperion(this.baseUrl, {
      async: true
    });

    client.onData = async (data, ack) => {
      const content = data.content;
      if (data.type === 'action') {
        const act = data.content.act;
        console.log(`\n >>>> Contract: ${act.account} | Action: ${act.name} | Block: ${content['block_num']} <<<< `);
        for (const key in act.data) {
          if (act.data.hasOwnProperty(key)) {
            console.log(`${key} = ${act.data[key]}`);
          }
        }
      }

      if (data.type === 'delta') {
        if (content.present === true) {
          const deltaData = content.data;
          console.log(`\n >>>> Block: ${content.block_num} | Contract: ${content.code}
          | Table: ${content.table} | Scope: ${content.scope} | Payer: ${content.payer} <<<< `);
          if (deltaData) {
            for (const key in deltaData) {
              if (deltaData.hasOwnProperty(key)) {
                console.log(`${key} = ${deltaData[key]}`);
              }
            }
          } else {
            console.log('ERROR >>>>>>>> ', content);
          }
        }
      }
      console.log('______________________');
      ack();
    };

    client.onConnect = () => {
      client.streamActions({
        contract: '',
        action: '',
        account: this.account,
        start_from: 0,
        read_until: 0,
        filters: [],
      });
    };

    client.connect(() => {
      console.log('connected!');
    });
  }

  getAccountData(acct) {
    this.http.get(this.baseUrl + '/v2/state/get_account?account=' + acct)
      .toPromise()
      .then((response: any) => {
        console.log(response);
        this.jsonData = response;

        if (response.account) {
          this.accountData = response.account;
        }

        if (response.tokens) {
          this.tokens = response.tokens;
        }

        if (response.actions) {
          this.actions = response.actions;
        }

      });
  }
}
