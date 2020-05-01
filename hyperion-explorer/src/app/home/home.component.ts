import {Component, OnInit} from '@angular/core';
import {FormBuilder, FormGroup, Validators} from '@angular/forms';
import {Router} from '@angular/router';
import {debounceTime} from 'rxjs/operators';
import {SearchService} from '../services/search.service';
import {AccountService} from '../services/account.service';
import {faSearch} from '@fortawesome/free-solid-svg-icons/faSearch';
import {ChainService} from '../services/chain.service';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css']
})
export class HomeComponent implements OnInit {
  searchForm: FormGroup;
  filteredAccounts: string[];
  faSearch = faSearch;
  searchPlaceholder: string;
  placeholders = [
    'Search by account name...',
    'Search by block number...',
    'Search by transaction id...',
    'Search by public key...'
  ];
  err: string = '';
  private currentPlaceholder = 0;

  constructor(
    private formBuilder: FormBuilder,
    private router: Router,
    private accountService: AccountService,
    private searchService: SearchService,
    public chainData: ChainService
  ) {
    this.searchForm = this.formBuilder.group({
      search_field: ['', Validators.required]
    });
    this.filteredAccounts = [];
    this.searchPlaceholder = this.placeholders[0];
    setInterval(() => {
      this.currentPlaceholder++;
      if (!this.placeholders[this.currentPlaceholder]) {
        this.currentPlaceholder = 0;
      }
      this.searchPlaceholder = this.placeholders[this.currentPlaceholder];
    }, 2000);
  }

  ngOnInit() {
    this.searchForm.get('search_field').valueChanges.pipe(debounceTime(300)).subscribe(async (result) => {
      this.filteredAccounts = await this.searchService.filterAccountNames(result);
    });
  }

  async submit() {
    if (!this.searchForm.valid) {
      return;
    }

    const searchText = this.searchForm.get('search_field').value;
    this.searchForm.reset();

    // tx id
    if (searchText.length === 64) {
      await this.router.navigate(['/transaction', searchText]);
      return;
    }

    // account
    if (this.filteredAccounts.length > 0 && searchText.length > 0 && searchText.length <= 12) {
      await this.router.navigate(['/account', searchText]);
      return;
    }

    // public key
    if (searchText.startsWith('PUB_K1_') || searchText.startsWith('EOS')) {
      await this.router.navigate(['/key', searchText]);
      return;
    }

    // block number
    let blockNum = searchText.replace(/[,.]/g, "");
    if (parseInt(blockNum, 10) > 0) {
      await this.router.navigate(['/block', blockNum]);
      return;
    }

    this.err = 'no results for ' + searchText;
  }
}
