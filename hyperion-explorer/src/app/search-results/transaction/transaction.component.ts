import {Component, OnDestroy, OnInit} from '@angular/core';
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
export class TransactionComponent implements OnInit, OnDestroy {
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
  countdownLoop: any;
  countdownTimer = 0;

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
      this.accountService.libNum = this.tx.lib;
      if (this.tx.actions[0].block_num > this.tx.lib) {
        await this.reloadCountdownTimer();
        this.countdownLoop = setInterval(async () => {
          this.countdownTimer--;
          if (this.countdownTimer <= 0) {
            await this.reloadCountdownTimer();
            if (this.accountService.libNum > this.tx.actions[0].block_num) {
              clearInterval(this.countdownLoop);
            }
          }
        }, 1000);
      }
    });
  }

  ngOnDestroy() {
    if (this.countdownLoop) {
      clearInterval(this.countdownLoop);
    }
  }

  formatDate(date: string) {
    return new Date(date).toLocaleString();
  }

  async reloadCountdownTimer() {
    await this.accountService.updateLib();
    this.countdownTimer = Math.ceil((this.tx.actions[0].block_num - this.accountService.libNum) / 2);
  }
}
