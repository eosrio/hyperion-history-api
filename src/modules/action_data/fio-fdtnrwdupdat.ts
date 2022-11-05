import {HyperionActionTransform} from "../../interfaces/hyperion-action-transform.js";

export const hyperionModule: HyperionActionTransform = {
  chain: '21dcae42c0182200e93f954a074011f9048a7624c6fe81d3c9541a614a88bd1c',
  contract: 'fio.treasury',
  action: 'fdtnrwdupdat',
  parser_version: ['1.8'],
  defineQueryPrefix: 'fdtnrwdupdat',
  mappings: {
    action: {
      '@fdtnrwdupdat': {
        'properties': {
          'amount': {'type': 'long'},
        },
      },
    },
  },
  handler: (action) => {
    const data = action['act']['data'];
    action['@fdtnrwdupdat'] = {
      amount: data['amount'],
    };
    delete action['act']['data'];
  },
};
