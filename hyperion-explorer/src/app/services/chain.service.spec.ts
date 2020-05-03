import { TestBed } from '@angular/core/testing';

import { ChainService } from './chain.service';

describe('ChainService', () => {
  let service: ChainService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(ChainService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
