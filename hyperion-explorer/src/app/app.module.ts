import {NgModule} from '@angular/core';
import {BrowserModule} from '@angular/platform-browser';
import {BrowserAnimationsModule} from '@angular/platform-browser/animations';
import {RouterModule, Routes} from '@angular/router';
import {HttpClientModule} from '@angular/common/http';
import {ReactiveFormsModule} from '@angular/forms';
import {MatToolbarModule} from '@angular/material/toolbar';
import {MatFormFieldModule} from '@angular/material/form-field';
import {MatInputModule} from '@angular/material/input';
import {MatAutocompleteModule} from '@angular/material/autocomplete';

import {AppComponent} from './app.component';
import {HomeComponent} from './home/home.component';
import {SearchResultsComponent} from './search-results/search-results.component';
import {AccountComponent} from './search-results/account/account.component';
import {MatCardModule} from '@angular/material/card';
import {FontAwesomeModule} from '@fortawesome/angular-fontawesome';
import {MatButtonModule} from '@angular/material/button';
import {FlexLayoutModule} from '@angular/flex-layout';
import {MatProgressBarModule} from '@angular/material/progress-bar';
import {MatTreeModule} from '@angular/material/tree';
import {MatTableModule} from '@angular/material/table';
import {MatSortModule} from '@angular/material/sort';
import {MatPaginatorModule} from '@angular/material/paginator';
import {CdkTableModule} from '@angular/cdk/table';
import {MatTooltipModule} from '@angular/material/tooltip';
import {TransactionComponent} from './search-results/transaction/transaction.component';
import {BlockComponent} from './search-results/block/block.component';
import {MatChipsModule} from '@angular/material/chips';
import {KeyComponent} from './search-results/key/key.component';
import {ServiceWorkerModule} from '@angular/service-worker';
import {environment} from '../environments/environment';

const appRoutes: Routes = [
  {
    path: '', component: HomeComponent
  },
  {
    path: '',
    component: SearchResultsComponent,
    children: [
      {path: 'account/:account_name', component: AccountComponent},
      {path: 'transaction/:transaction_id', component: TransactionComponent},
      {path: 'block/:block_num', component: BlockComponent},
      {path: 'key/:key', component: KeyComponent}
    ],
  },
  {
    path: '**', component: HomeComponent
  }
];

@NgModule({
  declarations: [
    AppComponent,
    HomeComponent,
    SearchResultsComponent,
    AccountComponent,
    TransactionComponent,
    BlockComponent,
    KeyComponent
  ],
  imports: [
    BrowserModule,
    BrowserAnimationsModule,
    ServiceWorkerModule.register('./ngsw-worker.js', {
      enabled: environment.production
    }),
    RouterModule.forRoot(appRoutes),
    ReactiveFormsModule,
    HttpClientModule,
    MatToolbarModule,
    MatFormFieldModule,
    MatInputModule,
    MatAutocompleteModule,
    MatCardModule,
    FontAwesomeModule,
    MatButtonModule,
    FlexLayoutModule,
    MatProgressBarModule,
    MatTreeModule,
    CdkTableModule,
    MatTableModule,
    MatPaginatorModule,
    MatSortModule,
    MatTooltipModule,
    MatChipsModule,
    RouterModule
  ],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule {
}
