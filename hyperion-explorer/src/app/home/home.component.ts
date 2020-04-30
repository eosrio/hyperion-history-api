import {Component, OnInit} from '@angular/core';
import {FormBuilder, FormGroup, Validators} from '@angular/forms';
import {Router} from '@angular/router';
import {debounceTime} from 'rxjs/operators';
import {SearchService} from '../services/search.service';
import {AccountService} from '../services/account.service';
import {faSearch} from "@fortawesome/free-solid-svg-icons/faSearch";
import {ChainService} from "../services/chain.service";

@Component({
    selector: 'app-home',
    templateUrl: './home.component.html',
    styleUrls: ['./home.component.css']
})
export class HomeComponent implements OnInit {
    searchForm: FormGroup;
    filteredAccounts: string[];
    faSearch = faSearch;

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

        const accountName = this.searchForm.get('search_field').value;
        this.searchForm.reset();
        await this.router.navigate(['/account', accountName]);
    }
}
