# Hyperion History API - Script

## Fix Missing Blocks

- Python script that connects to elastichsearch and identifies any missing blocks within indexes, and performs a re-indexing of those ranges to include any missing blocks.
- Once the script completes, it will automatically re-start the indexer on live mode with re-write disabled.

### Install & Run

```
pip3 install sh
pip3 install elasticsearch
python3 fix-missing-blocks.py http://elasticusername:elasticpasswordD@127.0.0.1
```


### TODO:
- Add progress 




