import {Component, OnInit, ViewChild} from '@angular/core';
import {ActivatedRoute} from '@angular/router';
import {AccountService} from '../../services/account.service';
import {MatSort} from '@angular/material/sort';
import {faClock} from '@fortawesome/free-solid-svg-icons/faClock';
import {faUserCircle} from '@fortawesome/free-solid-svg-icons/faUserCircle';
import {faCircle} from '@fortawesome/free-solid-svg-icons/faCircle';
import {faStar} from '@fortawesome/free-solid-svg-icons/faStar';
import {faLink} from '@fortawesome/free-solid-svg-icons/faLink';
import {faHistory} from '@fortawesome/free-solid-svg-icons/faHistory';
import {FlatTreeControl} from '@angular/cdk/tree';
import {MatTreeFlatDataSource, MatTreeFlattener} from '@angular/material/tree';
import {faChevronRight} from '@fortawesome/free-solid-svg-icons/faChevronRight';
import {faChevronDown} from '@fortawesome/free-solid-svg-icons/faChevronDown';
import {faKey} from '@fortawesome/free-solid-svg-icons/faKey';
import {faUser} from '@fortawesome/free-solid-svg-icons/faUser';
import {faSadTear} from '@fortawesome/free-solid-svg-icons/faSadTear';
import {isArray} from 'util';

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
  permission: Perm;
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

/** Flat node with expandable and level information */
interface FlatNode {
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

  treeControl: FlatTreeControl<FlatNode>;

  treeFlattener: MatTreeFlattener<any, any>;

  dataSource: MatTreeFlatDataSource<any, any>;
  detailedView = true;

  constructor(
    private activatedRoute: ActivatedRoute,
    public accountService: AccountService
  ) {

    this.treeControl = new FlatTreeControl<FlatNode>(
      node => node.level, node => node.expandable
    );

    this.treeFlattener = new MatTreeFlattener(
      this._transformer, node => node.level, node => node.expandable, node => node.children
    );

    this.dataSource = new MatTreeFlatDataSource(this.treeControl, this.treeFlattener);
  }

  _transformer = (node: Permission, level: number) => {
    return {
      expandable: !!node.children && node.children.length > 0,
      perm_name: node.perm_name,
      level,
      ...node
    };
  };

  objectKeyCount(obj) {
    try {
      return Object.keys(obj).length;
    } catch (e) {
      return 0;
    }
  }

  hasChild = (_: number, node: FlatNode) => node.expandable;


  ngOnInit() {
    this.activatedRoute.params.subscribe(async (routeParams) => {
      this.accountName = routeParams.account_name;
      if (await this.accountService.loadAccountData(routeParams.account_name)) {
        this.processPermissions();
        setTimeout(() => {
          this.accountService.tableDataSource.sort = this.sort;
        }, 500);
      }
    });
  }

  formatDate(date: string) {
    return new Date(date).toLocaleString();
  }

  getChildren(arr: Permission[], parent: string): Permission[] {
    return arr.filter(value => value.parent === parent).map((value) => {
      const children = this.getChildren(arr, value.perm_name);
      if (children.length > 0) {
        value.children = children;
      }
      return value;
    });
  }

  private processPermissions() {
    if (this.accountService.account) {
      const permissions: Permission[] = this.accountService.account.permissions;
      if (permissions) {
        try {
          this.dataSource.data = this.getChildren(permissions, '');
          console.log(this.dataSource._data);
          this.treeControl.expand(this.treeControl.dataNodes[0]);
          this.treeControl.expand(this.treeControl.dataNodes[1]);
        } catch (e) {
          console.log(e);
          this.dataSource.data = [];
        }
      }
    }
  }

  isArray(value: any) {
    return typeof value === 'object' && value.length > 0;
  }

  getType(subitem: any) {
    return typeof subitem;
  }
}
