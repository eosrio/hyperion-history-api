# Hyperion History API - Script

## Fix Missing Blocks

- Python script that connects to elasticsearch and identifies any missing blocks within indexes, and performs a re-indexing of those ranges to include any missing blocks.
- Once the script completes, it will automatically re-start the indexer on live mode with re-write disabled.

### Install

```
pip3 install sh
pip3 install elasticsearch==7.15.2
```

### Update the following 3 config lines in the python code.

```
hyperionfolder="/home/charles/hyperion-history-api"
indexer_log_file = "/home/charles/.pm2/logs/wax-indexer-out.log"
# Please set the version of Hyperion to either 3.1 or 3.3 to take into account changes to no blocks processed text in log file. 
hyperion_version = '3.3'  #'3.1' or '3.3'
```

### RUN

```
python3 fix-missing-blocks.py http://elasticusername:elasticpasswordD@127.0.0.1
```


### TODO:
- Add progress 




