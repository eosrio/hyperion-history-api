import {Component, OnDestroy, OnInit} from '@angular/core';
import {faCircle} from '@fortawesome/free-solid-svg-icons/faCircle';
import {faCube} from '@fortawesome/free-solid-svg-icons/faCube';
import {ActivatedRoute} from '@angular/router';
import {AccountService} from '../../services/account.service';
import {faHourglassStart} from '@fortawesome/free-solid-svg-icons/faHourglassStart';
import {faLock} from '@fortawesome/free-solid-svg-icons/faLock';
import {faHistory} from '@fortawesome/free-solid-svg-icons/faHistory';
import {animate, state, style, transition, trigger} from '@angular/animations';
import {faSpinner} from '@fortawesome/free-solid-svg-icons/faSpinner';
import {faSadTear} from '@fortawesome/free-solid-svg-icons/faSadTear';
import {faChevronRight} from '@fortawesome/free-solid-svg-icons/faChevronRight';
import {faChevronDown} from '@fortawesome/free-solid-svg-icons/faChevronDown';

@Component({
    selector: 'app-block',
    templateUrl: './block.component.html',
    styleUrls: ['./block.component.css'],
    animations: [
        trigger('detailExpand', [
            state('collapsed', style({height: '0px', minHeight: '0'})),
            state('expanded', style({height: '*'})),
            transition('expanded <=> collapsed', animate('225ms cubic-bezier(0.4, 0.0, 0.2, 1)')),
        ]),
    ],
})

export class BlockComponent implements OnInit, OnDestroy {
    columnsToDisplay: string[] = ['icon', 'id', 'root', 'action'];
    columnsInside: string[] = ['action', 'data', 'auth'];
    expandedElement: any | null;
    faCircle = faCircle;
    faBlock = faCube;
    faLock = faLock;
    faHourglass = faHourglassStart;
    faHistory = faHistory;
    faChevronRight = faChevronRight;
    faChevronDown = faChevronDown;
    faSadTear = faSadTear;
    faSpinner = faSpinner;
    block: any = {
        transactions: [],
        status: '',
        number: 0
    };
    blockNum: string;
    countdownLoop: any;
    countdownTimer = 0;

    objectKeyCount(obj) {
        try {
            return Object.keys(obj).length;
        } catch (e) {
            return 0;
        }
    }

    constructor(private activatedRoute: ActivatedRoute,
                public accountService: AccountService) {
    }

    ngOnInit(): void {
        this.activatedRoute.params.subscribe(async (routeParams) => {
            this.blockNum = routeParams.block_num;
            this.block = await this.accountService.loadBlockData(routeParams.block_num);
            if (this.block.status === 'pending') {
                await this.reloadCountdownTimer();
                this.countdownLoop = setInterval(async () => {
                    this.countdownTimer--;
                    if (this.countdownTimer <= 0) {
                        await this.reloadCountdownTimer();
                        if (this.accountService.libNum > this.block.number) {
                            clearInterval(this.countdownLoop);
                        }
                    }
                }, 1000);
            }
        });
    }

    async reloadCountdownTimer() {
        await this.accountService.updateLib();
        this.countdownTimer = Math.ceil((this.block.number - this.accountService.libNum) / 2);
    }

    ngOnDestroy() {
        if (this.countdownLoop) {
            clearInterval(this.countdownLoop);
        }
    }

    formatDate(date: string) {
        return new Date(date).toLocaleString();
    }

}
