#!/bin/bash
#
# syncbyrange.sh - Bash script for synchronizing Hyperion EOS in spans 
# Save this in your Hyperion folder and add to cron 
# to run this every 10 minutes... just add this to your cron
# */10 * * * * /opt/eosio/src/Hyperion-History-API/scripts/sync-by=range.sh
#
# You can modify the CHAINNAME variable to match your chains/$CHAINNAME.config.json
#
# variables that need to be set based on your configuration

PM2="/home/eosio/.npm-global/bin/pm2"
HYPERIONPATH="/opt/eosio/src/Hyperion-History-API"
BLOCKSPAN="1000000"
CHAINNAME="proton"
CHAINCONF="$HYPERIONPATH/chains/$CHAINNAME.config.json"

# variables that probably don't need to change
INDEXER="$CHAINNAME-indexer"
LOGFILE=$HYPERIONPATH/logs/$CHAINNAME-sync.log
echo `date` >> $LOGFILE

# Get logs from pm2 and lastblock from config file
LOG=`$PM2 log $INDEXER --nostream --lines 4`
LASTBLOCK=`cat $CHAINCONF |jq '.indexer.stop_on'|tr -d '"'`

# if the log contains "No blocks are being processed" then update the configs for the next block span
if echo $LOG | grep -q "No blocks are being processed"; then 
    echo "Updating configs to next span" >> $LOGFILE
    timeout 10 $PM2 trigger "$INDEXER" stop
    LASTBLOCK=`cat $CHAINCONF |jq '.indexer.stop_on'|tr -d '"'`
    STARTBLOCK=`echo $LASTBLOCK`
    STOPBLOCK=`expr $LASTBLOCK + $BLOCKSPAN`
    echo "Updating $CHAINCONF to $STARTBLOCK:$STOPBLOCK" >> $LOGFILE
    jq --argjson STARTBLOCK "$STARTBLOCK" '.indexer.start_on = $STARTBLOCK' $CHAINCONF > $CHAINCONF.tmp
    jq --argjson STOPBLOCK "$STOPBLOCK" '.indexer.stop_on = $STOPBLOCK' $CHAINCONF.tmp > $CHAINCONF.tmp2
    cp $CHAINCONF.tmp2 $CHAINCONF
    echo "Updated config to sync $CHAIN from $STARTBLOCK to $STOPBLOCK" >> $LOGFILE
    echo -e "\n-->> Starting $1..."
    cd $HYPERIONPATH
    $PM2 start --only "$INDEXER" --update-env --silent
    $PM2 save
else
    LASTBLOCK=`cat $CHAINCONF |jq '.indexer.stop_on'|tr -d '"'`
    STARTBLOCK=`cat $CHAINCONF |jq '.indexer.start_on'|tr -d '"'`
   echo "Still synchronizing $CHAIN from $STARTBLOCK to $LASTBLOCK" >> $LOGFILE
fi 
