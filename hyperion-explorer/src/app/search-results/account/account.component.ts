import {Component, OnDestroy, OnInit, ViewChild} from '@angular/core';
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
import {MatPaginator, PageEvent} from '@angular/material/paginator';
import {faVoteYea} from '@fortawesome/free-solid-svg-icons/faVoteYea';
import {faQuestionCircle} from '@fortawesome/free-regular-svg-icons/faQuestionCircle';
import {AccountCreationData} from '../../interfaces';
import {max} from 'rxjs/operators';

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
export class AccountComponent implements OnInit, OnDestroy {

  @ViewChild(MatSort, {static: false}) sort: MatSort;
  @ViewChild(MatPaginator, {static: false}) paginator: MatPaginator;

  // FontAwesome Icons
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
  faVote = faVoteYea;
  faQuestionCircle = faQuestionCircle;

  accountName: string;

  columnsToDisplay: string[] = ['trx_id', 'action', 'data', 'block_num'];

  treeControl: FlatTreeControl<FlatNode>;

  treeFlattener: MatTreeFlattener<any, any>;

  dataSource: MatTreeFlatDataSource<any, any>;
  detailedView = true;

  systemPrecision = 4;
  systemSymbol:string = '';
  creationData: AccountCreationData = {
    creator: undefined,
    timestamp: undefined
  };

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

  ngOnDestroy() {
    console.log('ngOnDestroy');
    this.accountService.disconnectStream();
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

      if (this.accountService.streamClientStatus) {
        this.accountService.disconnectStream();
      }

      this.accountName = routeParams.account_name;
      if (await this.accountService.loadAccountData(routeParams.account_name)) {
        this.systemPrecision = this.getPrecision(this.accountService.account.core_liquid_balance);
        this.systemSymbol = this.accountService.account.core_liquid_balance.split(' ')[1];
        this.processPermissions();
        setTimeout(() => {
          this.accountService.tableDataSource.sort = this.sort;
          this.accountService.tableDataSource.paginator = this.paginator;
        }, 500);
        this.creationData = await this.accountService.getCreator(routeParams.account_name);
      }
    });
  }

  getPrecision(asset: string): number {
    if (asset) {
      try {
        return asset.split(' ')[0].split('.')[1].length;
      } catch (e) {
        return 4;
      }
    } else {
      return 4;
    }
  }

  liquidBalance() {
    if (this.accountService.account.core_liquid_balance) {
      return parseFloat(this.accountService.account.core_liquid_balance.split(' ')[0]);
    }
    return 0;
  }

  myCpuBalance() {
    if (this.accountService.account.self_delegated_bandwidth) {
      return parseFloat(this.accountService.account.self_delegated_bandwidth.cpu_weight.split(' ')[0]);
    }
    return 0;
  }

  myNetBalance() {
    if (this.accountService.account.self_delegated_bandwidth) {
      return parseFloat(this.accountService.account.self_delegated_bandwidth.net_weight.split(' ')[0]);
    }
    return 0;
  }

  cpuBalance() {
    if (this.accountService.account.total_resources) {
      return parseFloat(this.accountService.account.total_resources.cpu_weight.split(' ')[0]);
    }
    return 0;
  }

  netBalance() {
    if (this.accountService.account.total_resources) {
      return parseFloat(this.accountService.account.total_resources.net_weight.split(' ')[0]);
    }
    return 0;
  }

  totalBalance() {
    const liquid = this.liquidBalance();
    const cpu = this.myCpuBalance();
    const net = this.myNetBalance();
    return liquid + cpu + net;
  }

  stakedBalance() {
    const cpu = this.myCpuBalance();
    const net = this.myNetBalance();
    return cpu + net;
  }

  cpuByOthers() {
    const cpu = this.cpuBalance();
    const mycpu = this.myCpuBalance();
    return cpu - mycpu;
  }

  netByOthers() {
    const net = this.netBalance();
    const mynet = this.myNetBalance();
    return net - mynet;
  }

  stakedbyOthers() {
    const cpu = this.cpuBalance();
    const net = this.netBalance();
    const mycpu = this.myCpuBalance();
    const mynet = this.myNetBalance();
    return (cpu + net) - (mycpu + mynet);
  }

  refundBalance() {
    let cpuRefund = 0;
    let netRefund = 0;
    if (this.accountService.account.refund_request) {
      cpuRefund = parseFloat(this.accountService.account.refund_request.cpu_amount.split(' ')[0]);
      netRefund = parseFloat(this.accountService.account.refund_request.net_amount.split(' ')[0]);
    }
    return cpuRefund + netRefund;
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

  convertBytes(bytes: number) {
    if (bytes > (1024 ** 3)) {
      return (bytes / (1024 ** 3)).toFixed(2) + ' GB';
    }
    if (bytes > (1024 ** 2)) {
      return (bytes / (1024 ** 2)).toFixed(2) + ' MB';
    }
    if (bytes > 1024) {
      return (bytes / (1024)).toFixed(2) + ' KB';
    }
    return bytes + ' bytes';
  }

  convertMicroS(micros: number) {
    let int = 0;
    let remainder = 0;
    const calcSec = 1000 ** 2;
    const calcMin = calcSec * 60;
    const calcHour = calcMin * 60;
    if (micros > calcHour) {
      int = Math.floor(micros / calcHour);
      remainder = micros % calcHour;
      return int + 'h ' + Math.round(remainder / calcMin) + 'min';
    }
    if (micros > calcMin) {
      int = Math.floor(micros / calcMin);
      remainder = micros % calcMin;
      return int + 'min ' + Math.round(remainder / calcSec) + 's';
    }
    if (micros > calcSec) {
      return (micros / calcSec).toFixed(2) + 's';
    }
    if (micros > 1000) {
      return (micros / (1000)).toFixed(2) + 'ms';
    }
    return micros + 'µs';
  }

  changePage(event: PageEvent) {

    // disable streaming if enabled
    if (this.accountService.streamClientStatus) {
      this.accountService.toggleStreaming();
    }

    const maxPages = Math.floor(event.length / event.pageSize);
    console.log(event);
    console.log(`${event.pageIndex} / ${maxPages}`);
    try {
      if (event.pageIndex === maxPages - 1) {
        this.accountService.loadMoreActions(this.accountName).catch(console.log);
      }
    } catch (e) {
      console.log(e);
    }
  }
}
