import {Component, OnInit} from '@angular/core';
import {ActivatedRoute} from '@angular/router';
import {AccountService} from '../../services/account.service';
import {faExchangeAlt} from '@fortawesome/free-solid-svg-icons/faExchangeAlt';
import {faCircle} from '@fortawesome/free-solid-svg-icons/faCircle';
import {faLock} from '@fortawesome/free-solid-svg-icons/faLock';
import {faHourglassStart} from '@fortawesome/free-solid-svg-icons/faHourglassStart';
import {faHistory} from '@fortawesome/free-solid-svg-icons/faHistory';
import {faSadTear} from '@fortawesome/free-solid-svg-icons/faSadTear';
import {faSpinner} from '@fortawesome/free-solid-svg-icons/faSpinner';

@Component({
  selector: 'app-transaction',
  templateUrl: './transaction.component.html',
  styleUrls: ['./transaction.component.css']
})
export class TransactionComponent implements OnInit {
  columnsToDisplay: string[] = ['contract', 'action', 'data', 'auth'];
  tx: any = {
    actions: null
  };
  faCircle = faCircle;
  faExchange = faExchangeAlt;
  faLock = faLock;
  faHourglass = faHourglassStart;
  faHistory = faHistory;
  faSadTear = faSadTear;
  faSpinner = faSpinner;
  txID: string;

  objectKeyCount(obj) {
    try {
      return Object.keys(obj).length;
    } catch (e) {
      return 0;
    }
  }

  constructor(private activatedRoute: ActivatedRoute, public accountService: AccountService) {
  }

  ngOnInit() {
    this.activatedRoute.params.subscribe(async (routeParams) => {
      this.txID = routeParams.transaction_id;
      this.tx = await this.accountService.loadTxData(routeParams.transaction_id);
      await this.accountService.updateLib();
    });
  }

  formatDate(date: string) {
    return new Date(date).toLocaleString();
  }

}
