import {Component, OnInit, ViewChild} from '@angular/core';
import {ActivatedRoute} from '@angular/router';
import {AccountService} from '../../services/account.service';
import {MatSort} from "@angular/material/sort";
import {faClock} from "@fortawesome/free-solid-svg-icons/faClock";
import {faUserCircle} from "@fortawesome/free-solid-svg-icons/faUserCircle";
import {faCircle} from "@fortawesome/free-solid-svg-icons/faCircle";
import {faStar} from "@fortawesome/free-solid-svg-icons/faStar";
import {faLink} from "@fortawesome/free-solid-svg-icons/faLink";
import {faHistory} from "@fortawesome/free-solid-svg-icons/faHistory";
import {FlatTreeControl} from "@angular/cdk/tree";
import {MatTreeFlatDataSource, MatTreeFlattener} from "@angular/material/tree";
import {faChevronRight} from "@fortawesome/free-solid-svg-icons/faChevronRight";
import {faChevronDown} from "@fortawesome/free-solid-svg-icons/faChevronDown";
import {faKey} from "@fortawesome/free-solid-svg-icons/faKey";
import {faUser} from "@fortawesome/free-solid-svg-icons/faUser";
import {faSadTear} from "@fortawesome/free-solid-svg-icons/faSadTear";

interface Permission {
  perm_name: string;
  parent: string;
  required_auth: RequiredAuth;
  children?: Permission[];
}

interface RequiredAuth {
  threshold: number;
  keys: Keys[];
  accounts?: Accs[];
  waits?: Waits[];
}

interface Keys {
  key: string;
  weight: number;
}

interface Accs {
  permission: Perm[];
  weight: number;
}

interface Perm {
  actor: string;
  permission: string;
}

interface Waits {
  wait_sec: number;
  weight: number;
}

const TREE_DATA: Permission[] = [
  {
    perm_name: 'owner',
    parent: '',
    required_auth: {
      threshold: 1,
      keys: [{
        key: 'EOS6a6mHd9D3PtXYPjNS2h9DrExkpAhzgrn54YBv42kz6AQprVgQw',
        weight: 1
      }],
      accounts: [],
      waits: [],
    },
    children: [
      {
        perm_name: 'active',
        parent: 'owner',
        required_auth: {
          threshold: 1,
          keys: [{
            key: 'EOS6a6mHd9D3PtXYPjNS2h9DrExkpAhzgrn54YBv42kz6AQprVgQw',
            weight: 1
          }],
          accounts: [{
            permission: [
              {
                actor: 'waxbetstaket',
                permission: 'eosio.code'
              }
            ],
            weight: 1,
          }],
          waits: [],
        },
        children: []
      }
    ]
  }
];

/** Flat node with expandable and level information */
interface ExampleFlatNode {
  expandable: boolean;
  perm_name: string;
  level: number;
}

@Component({
  selector: 'app-account',
  templateUrl: './account.component.html',
  styleUrls: ['./account.component.css']
})
export class AccountComponent implements OnInit {
  columnsToDisplay: string[] = ['trx_id', 'action', 'data', 'block_num'];
  @ViewChild(MatSort, {static: false}) sort: MatSort;
  faClock = faClock;
  faUserCircle = faUserCircle;
  faCircle = faCircle;
  faStar = faStar;
  faLink = faLink;
  faHistory = faHistory;
  faChevronRight = faChevronRight;
  faChevronDown = faChevronDown;
  faSadTear = faSadTear;
  faKey = faKey;
  faUser = faUser;
  accountName: string;

  private _transformer = (node: Permission, level: number) => {
    return {
      expandable: !!node.children && node.children.length > 0,
      perm_name: node.perm_name,
      level: level,
      ...node
    };
  }

  objectKeyCount(obj) {
    try {
      return Object.keys(obj).length;
    } catch (e) {
      return 0;
    }
  }

  treeControl = new FlatTreeControl<ExampleFlatNode>(
    node => node.level, node => node.expandable
  );

  treeFlattener = new MatTreeFlattener(
    this._transformer, node => node.level, node => node.expandable, node => node.children
  );

  dataSource = new MatTreeFlatDataSource(this.treeControl, this.treeFlattener);

  constructor(
    private activatedRoute: ActivatedRoute,
    public accountService: AccountService
  ) {
    this.dataSource.data = TREE_DATA;
    this.treeControl.expand(this.treeControl.dataNodes[0]);
    this.treeControl.expand(this.treeControl.dataNodes[1]);
  }

  hasChild = (_: number, node: ExampleFlatNode) => node.expandable;


  ngOnInit() {
    this.activatedRoute.params.subscribe(async (routeParams) => {
      this.accountName = routeParams.account_name;
      await this.accountService.loadAccountData(routeParams.account_name);
      setTimeout(() => {
        this.accountService.tableDataSource.sort = this.sort;
      }, 500);
    });
  }

  formatDate(date: string) {
    return new Date(date).toLocaleString();
  }
}
