import {Component, OnInit} from '@angular/core';
import {ActivatedRoute} from "@angular/router";
import {AccountService} from "../../services/account.service";
import {faCircle} from "@fortawesome/free-solid-svg-icons/faCircle";
import {faKey} from "@fortawesome/free-solid-svg-icons/faKey";
import {faSadTear} from "@fortawesome/free-solid-svg-icons/faSadTear";
import {faSpinner} from "@fortawesome/free-solid-svg-icons/faSpinner";

interface KeyResponse {
  account_names: string[];
  permissions: any[];
}

@Component({
  selector: 'app-key',
  templateUrl: './key.component.html',
  styleUrls: ['./key.component.css']
})
export class KeyComponent implements OnInit {
  key: KeyResponse = {
    account_names: null,
    permissions: null
  };
  pubKey: string;
  faCircle = faCircle;
  faKey = faKey;
  faSadTear = faSadTear;
  faSpinner = faSpinner;

  constructor(private activatedRoute: ActivatedRoute,
              public accountService: AccountService) {
  }

  ngOnInit(): void {
    this.activatedRoute.params.subscribe(async (routeParams) => {
      this.pubKey = routeParams.key;
      this.key = await this.accountService.loadPubKey(routeParams.key) as KeyResponse;
    });
  }

}
