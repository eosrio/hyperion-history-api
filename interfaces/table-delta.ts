export interface DeltaRow {
    present: boolean;
    data: any;
}

export interface TableDelta {
    name: string;
    rows: DeltaRow[]
}