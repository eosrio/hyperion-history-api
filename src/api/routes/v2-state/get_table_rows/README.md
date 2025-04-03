# Get Table Rows API Documentation

## Overview
The `get_table_rows` API allows users to retrieve rows from a specified contract table. This API supports filtering, sorting, and pagination to provide flexible querying capabilities.

## Endpoint
**GET** `/v2/state/get_table_rows`

## Query Parameters

| Parameter       | Type     | Description                                                                                     | Required | Default |
|-----------------|----------|-------------------------------------------------------------------------------------------------|----------|---------|
| `contract`      | `string` | Contract name.                                                                                 | Yes      | -       |
| `table`         | `string` | Table name.                                                                                    | Yes      | -       |
| `primary_key`   | `string` | Filter by primary key.                                                                         | No       | -       |
| `scope`         | `string` | Filter by scope.                                                                               | No       | -       |
| `block_id`      | `string` | Filter by block ID.                                                                            | No       | -       |
| `block_num`     | `integer`| Filter by block number.                                                                        | No       | -       |
| `block_time`    | `string` | Filter by block time.                                                                          | No       | -       |
| `payer`         | `string` | Filter by payer account.                                                                       | No       | -       |
| `filters`       | `string` | JSON string containing dynamic filters. Supports MongoDB query operators like `$gt`, `$lt`.   | No       | -       |
| `sort_by`       | `string` | Field name to sort results by.                                                                | No       | -       |
| `sort_direction`| `string` | Sort direction: `asc` for ascending, `desc` for descending.                                   | No       | `asc`   |

## Response
The API returns a JSON object with the following structure:

```json
{
  "rows_count": 0,
  "sort_by": "",
  "sort_direction": "asc",
  "rows": [
    {
      "@pk": "",
      "@scope": "",
      "@block_id": "",
      "@block_num": 0,
      "@block_time": "",
      "@payer": "",
      "...": "additional properties"
    }
  ]
}
```

### Response Fields
- `rows_count`: Total number of rows matching the query.
- `sort_by`: Field used for sorting the results.
- `sort_direction`: Direction of sorting (`asc` or `desc`).
- `rows`: Array of table rows. Each row contains the following fields:
  - `@pk`: Primary key value.
  - `@scope`: Scope of the table row.
  - `@block_id`: Block ID when the row was last modified.
  - `@block_num`: Block number when the row was last modified.
  - `@block_time`: Block timestamp when the row was last modified.
  - `@payer`: Account name that paid for this row.
  - Additional properties may be included depending on the table schema.

## Examples

### Example 1: Querying Token Balances
Retrieve all token balances for a specific account from the `eosio.token` contract.

**Request:**
```http
GET /v2/state/get_table_rows?contract=eosio.token&table=accounts&scope=myaccount
```

**Response:**
```json
{
  "rows_count": 1,
  "sort_by": "",
  "sort_direction": "asc",
  "rows": [
    {
      "@pk": "",
      "@scope": "myaccount",
      "@block_id": "abc123",
      "@block_num": 100,
      "@block_time": "2025-04-01T12:00:00Z",
      "@payer": "myaccount",
      "balance": "100.0000 EOS"
    }
  ]
}
```

### Example 2: Retrieving Proposals
Retrieve active proposals from the `eosio.msig` contract.

**Request:**
```http
GET /v2/state/get_table_rows?contract=eosio.msig&table=proposals&scope=mydao
```

**Response:**
```json
{
  "rows_count": 2,
  "sort_by": "",
  "sort_direction": "asc",
  "rows": [
    {
      "@pk": "proposal1",
      "@scope": "mydao",
      "@block_id": "def456",
      "@block_num": 101,
      "@block_time": "2025-04-01T12:05:00Z",
      "@payer": "mydao",
      "proposal_name": "proposal1",
      "requested_approvals": ["user1", "user2"]
    },
    {
      "@pk": "proposal2",
      "@scope": "mydao",
      "@block_id": "ghi789",
      "@block_num": 102,
      "@block_time": "2025-04-01T12:10:00Z",
      "@payer": "mydao",
      "proposal_name": "proposal2",
      "requested_approvals": ["user3", "user4"]
    }
  ]
}
```

### Example 3: Querying Voter Information
Retrieve voter information from the `eosio` contract.

**Request:**
```http
GET /v2/state/get_table_rows?contract=eosio&table=voters&scope=myvoter
```

**Response:**
```json
{
  "rows_count": 1,
  "sort_by": "",
  "sort_direction": "asc",
  "rows": [
    {
      "@pk": "myvoter",
      "@scope": "myvoter",
      "@block_id": "jkl012",
      "@block_num": 103,
      "@block_time": "2025-04-01T12:15:00Z",
      "@payer": "myvoter",
      "staked": "5000.0000 EOS",
      "last_vote_weight": "100000.0000"
    }
  ]
}
```

### Example 4: Filtering by Block Number
Retrieve rows where the block number is greater than 100.

**Request:**
```http
GET /v2/state/get_table_rows?contract=eosio.token&table=accounts&filters={"@block_num":{"$gt":100}}
```

**Response:**
```json
{
  "rows_count": 1,
  "sort_by": "",
  "sort_direction": "asc",
  "rows": [
    {
      "@pk": "",
      "@scope": "myaccount",
      "@block_id": "abc123",
      "@block_num": 101,
      "@block_time": "2025-04-01T12:00:00Z",
      "@payer": "myaccount",
      "balance": "100.0000 EOS"
    }
  ]
}
```

### Example 5: Filtering by Multiple Conditions
Retrieve rows where the block number is greater than 100 and the payer is `myaccount`.

**Request:**
```http
GET /v2/state/get_table_rows?contract=eosio.token&table=accounts&filters={"@block_num":{"$gt":100},"@payer":"myaccount"}
```

**Response:**
```json
{
  "rows_count": 1,
  "sort_by": "",
  "sort_direction": "asc",
  "rows": [
    {
      "@pk": "",
      "@scope": "myaccount",
      "@block_id": "abc123",
      "@block_num": 101,
      "@block_time": "2025-04-01T12:00:00Z",
      "@payer": "myaccount",
      "balance": "100.0000 EOS"
    }
  ]
}
```

### Example 6: Filtering by Date
Retrieve rows where the block time is after `2025-04-01T12:00:00Z`.

**Request:**
```http
GET /v2/state/get_table_rows?contract=eosio.token&table=accounts&filters={"@block_time":{"$gt":"2025-04-01T12:00:00Z"}}
```

**Response:**
```json
{
  "rows_count": 1,
  "sort_by": "",
  "sort_direction": "asc",
  "rows": [
    {
      "@pk": "",
      "@scope": "myaccount",
      "@block_id": "abc123",
      "@block_num": 101,
      "@block_time": "2025-04-01T12:05:00Z",
      "@payer": "myaccount",
      "balance": "100.0000 EOS"
    }
  ]
}
```

### Example 7: Filtering by Numeric Field
Retrieve rows where the `staked` amount is greater than `5000.0000`.

**Request:**
```http
GET /v2/state/get_table_rows?contract=eosio&table=voters&filters={"staked":{"$gt":5000.0000}}
```

**Response:**
```json
{
  "rows_count": 1,
  "sort_by": "",
  "sort_direction": "asc",
  "rows": [
    {
      "@pk": "myvoter",
      "@scope": "myvoter",
      "@block_id": "jkl012",
      "@block_num": 103,
      "@block_time": "2025-04-01T12:15:00Z",
      "@payer": "myvoter",
      "staked": 6000.0000,
      "last_vote_weight": "100000.0000"
    }
  ]
}
```

## Error Handling
- Missing required parameters will result in a `400 Bad Request` error.
- Invalid filters or date formats will result in a `400 Bad Request` error with a descriptive message.

## Notes
- The `filters` parameter supports MongoDB query operators such as `$gt`, `$lt`, `$gte`, `$lte`, `$in`, etc.
- Date strings in filters are automatically converted to MongoDB date objects for comparison.