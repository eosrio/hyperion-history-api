# Hyperion History API - Script

## Fix Missing Blocks

- Python script that connects to elasticsearch and identifies any missing blocks within indexes, and performs a re-indexing of those ranges to include any missing blocks.
- Once the script completes, it will automatically re-start the indexer on live mode with re-write disabled.

### Install

```
pip3 install -r requirements.txt
```

### Update the following 2 config lines in the python code.

Please set the Chain to whatever your chain in chains/"chain".config.json is named
This script supports Hyperion versions 3.3.1, 3.3.3, or 3.3.5 - which you must enter as: '3.1', '3.3', or '3.5' because that's how Charles likes it.

```
chain = "libre"  
hyperion_version = '3.5'  
```

### RUN

You should run this from your Hyperion directory by using the following command and indicating the user, pass from your elastic_pass.txt and url to your elasticsearch (default is 127.0.0.1):

```
python3 ./scripts/fix-missing-blocks.py http://elasticusername:elasticpasswordD@127.0.0.1
```


### TODO:
- Add progress 




