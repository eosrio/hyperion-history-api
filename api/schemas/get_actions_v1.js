exports.POST = {
  description: 'get actions based on notified account. this endpoint also accepts generic filters based on indexed fields' +
      ' (e.g. act.authorization.actor=eosio or act.name=delegatebw), if included they will be combined with a AND operator',
  summary: 'get root actions',
  tags: ['history'],
  body: {
      type: 'object',
      properties: {
          "account": {
              description: 'notified account',
              type: 'string',
              minLength: 1,
              maxLength: 12
          },
          "filter": {
              description: 'code:name filter',
              type: 'string',
              minLength: 3
          },
          "pos": {
              description: 'action position (pagination)',
              type: 'integer'
          },
          "offset": {
              description: 'limit of [n] actions per page',
              type: 'integer'
          },
          "sort": {
              description: 'sort direction',
              enum: ['desc', 'asc', '1', '-1'],
              type: 'string'
          },
          "after": {
              description: 'filter after specified date (ISO8601)',
              type: 'string',
              format: 'date-time'
          },
          "before": {
              description: 'filter before specified date (ISO8601)',
              type: 'string',
              format: 'date-time'
          },
          "parent": {
              description: 'filter by parent global sequence',
              type: 'integer',
              minimum: 0
          }
      }
  },
//   response: {
//       200: {
//           type: 'object',
//           properties: {
//               "query_time": {
//                   type: "number"
//               },
//               "last_irreversible_block": {
//                   type: "number"
//               },
//               "time_limit_exceeded_error": {
//                   type: ["boolean", "null"]
//               },
//               "total": {
//                   type: "object",
//                   properties: {
//                       "value": {type: "number"},
//                       "relation": {type: "string"}
//                   }
//               },
//               "actions": {
//                   type: "array",
//                   items: {
//                       type: 'object',
//                       properties: {
//                           "account_action_seq": {type: "number"},
//                           "action_trace": {
//                               type: 'object',
//                               properties: {
//                                 "receipt": {type: "object"},
//                                 "act": {type: "object"},
//                                 "elapsed": {type: "number"},
//                                 "console": {type: "string"},
//                                 "trx_id": {type: "string"},
//                                 "block_num": {type: "number"},
//                                 "block_time": {type: "string"},
//                                 "producer_block_id": {type: "string"},
//                                 "account_ram_deltas": {type: "array"},
//                                 "except": {type: ["object", "null"]},
//                                 "inline_traces": {type: "array"}
//                               },
//                               additionalProperties: true
//                           },
//                           "block_time": {type: "string"},
//                           "block_num": {type: "number"},
//                           "global_action_seq": {type: "number"}
//                       }
//                   }
//               }
//           }
//       }
//   }
};
