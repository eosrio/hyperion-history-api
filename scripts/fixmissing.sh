#!/bin/bash
#
# fixmissing.sh - Bash script for finding missing blocks in the pm2 logs 
# Update paths and then you can run this as a test if you have missing blocks in the log 
# to run this every 2 minutes... just add this to your cron
# */2 * * * * /opt/eosio/src/Hyperion-History-API/scripts/fixmissing.sh
#
#
# variables that need to be set based on your configuration
PM2="/home/eosio/.npm-global/bin/pm2"
HYPERIONPATH="/opt/eosio/src/Hyperion-History-API"
BLOCKSPAN="1000000"
CHAINNAME="proton"
CHAINCONF="$HYPERIONPATH/chains/$CHAINNAME.config.json"
PM2USER="eosio"
PM2HOME="`eval echo ~$PM2USER`/.pm2/logs"

# variables that probably don't need to change
INDEXER="$CHAINNAME-indexer"
PM2LOG=$PM2HOME/$INDEXER-out.log
LOGFILE=$HYPERIONPATH/logs/$CHAINNAME-fixmissing.log
echo `date` >> $LOGFILE

# Check pm2 logs to see if there is a "Mising block:" and then set that as the new STARTBLOCK
if tail -n 100 $PM2LOG | grep -q "Missing block:"; then 
    timeout 10 $PM2 trigger "$INDEXER" stop
    echo "Missed block found" >> $LOGFILE
    STARTBLOCK=`tail -n 100 $PM2LOG|grep 'Missing block:'|awk '{print $7}'|head -n 1`
    echo "Updating $CHAINCONF to reindex $STARTBLOCK" >> $LOGFILE
    jq --argjson STARTBLOCK "$STARTBLOCK" '.indexer.start_on = $STARTBLOCK' $CHAINCONF > $CHAINCONF.tmp3
    cp $CHAINCONF.tmp3 $CHAINCONF
    echo "Updated config to sync $CHAIN to reindex $STARTBLOCK" >> $LOGFILE
    echo -e "\n-->> Starting $INDEXER..."
    cd $HYPERIONPATH
    $PM2 start --only "$INDEXER" --update-env --silent
    $PM2 save
else
    LASTBLOCK=`cat $CHAINCONF |jq '.indexer.stop_on'|tr -d '"'`
    STARTBLOCK=`cat $CHAINCONF |jq '.indexer.start_on'|tr -d '"'`
   echo "No missed blocks on $CHAIN from $STARTBLOCK to $LASTBLOCK" >> $LOGFILE
fi 
