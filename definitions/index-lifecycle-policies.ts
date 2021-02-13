import {IlmPutLifecycle} from "@elastic/elasticsearch/api/requestParams";

export const ILPs: IlmPutLifecycle[] = [
    {
        policy: "hyperion-rollover",
        body: {
            "policy": {
                "phases": {
                    "hot": {
                        "min_age": "0ms",
                        "actions": {
                            "rollover": {
                                "max_size": "200gb",
                                "max_age": "60d",
                                "max_docs": 100000000
                            },
                            "set_priority": {
                                "priority": 50
                            }
                        }
                    },
                    "warm": {
                        "min_age": "2d",
                        "actions": {
                            "allocate": {
                                "exclude": {
                                    "data": "hot"
                                }
                            },
                            "set_priority": {
                                "priority": 25
                            }
                        }
                    }
                }
            }
        }
    },
    {
        policy: "50G30D",
        body: {
            policy: {
                phases: {
                    hot: {
                        min_age: "0ms",
                        actions: {
                            rollover: {
                                max_age: "30d",
                                max_size: "50gb"
                            },
                            set_priority: {
                                priority: 100
                            }
                        }
                    }
                }
            }
        }
    },
    {
        policy: "10G30D",
        body: {
            policy: {
                phases: {
                    hot: {
                        min_age: "0ms",
                        actions: {
                            rollover: {
                                max_age: "30d",
                                max_size: "10gb",
                                max_docs: 100000000
                            },
                            set_priority: {
                                priority: 100
                            }
                        }
                    }
                }
            }
        }
    },
    {
        policy: "200G",
        body: {
            policy: {
                phases: {
                    hot: {
                        min_age: "0ms",
                        actions: {
                            rollover: {
                                max_size: "200gb"
                            },
                            set_priority: {
                                priority: 100
                            }
                        }
                    }
                }
            }
        }
    }
];
