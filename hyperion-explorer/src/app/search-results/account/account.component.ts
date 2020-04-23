import {Component, OnInit} from '@angular/core';
import {ActivatedRoute} from '@angular/router';
import {AccountService} from '../../services/account.service';

@Component({
  selector: 'app-account',
  templateUrl: './account.component.html',
  styleUrls: ['./account.component.css']
})
export class AccountComponent implements OnInit {

  constructor(
    private activatedRoute: ActivatedRoute,
    public accountService: AccountService
  ) {
  }

  ngOnInit() {
    this.activatedRoute.params.subscribe(async (routeParams) => {
      await this.accountService.loadAccountData(routeParams.account_name);
    });
  }
}
