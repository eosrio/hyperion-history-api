#!/bin/bash
#
# sync.sh - Bash script for synchronizing Hyperion EOS in spans 
# Save this in your Hyperion folder and add to cron 
# to run this every 10 minutes... just add this to your cron
# */10 * * * * /opt/eosio/src/Hyperion-History-API/syncpan.sh
#
#
# variables that need to be set based on your configuration

PM2="/home/eosio/.npm-global/bin/pm2"
HYPERIONPATH="/opt/eosio/src/Hyperion-History-API"
CHAINNAME="proton"
CHAINCONF="$HYPERIONPATH/chains/$CHAINNAME.config.json"

# variables that probably don't need to change
INDEXER="$CHAINNAME-indexer"
#LOGFILE=$HYPERIONPATH/logs/$CHAINNAME-sync.log
#echo `date` >> $LOGFILE

# Get logs from pm2 and lastblock from config file
timeout 10 $PM2 trigger "$INDEXER" stop
SKIPBLOCK="$1"
STARTBLOCK=`expr $SKIPBLOCK + 1`
echo "Updating $CHAINCONF to $STARTBLOCK:$STOPBLOCK"
jq --argjson STARTBLOCK "$STARTBLOCK" '.indexer.start_on = $STARTBLOCK' $CHAINCONF > $CHAINCONF.tmp
cp $CHAINCONF.tmp $CHAINCONF
echo "Updated config to sync $CHAIN from $STARTBLOCK to $STOPBLOCK"
cd $HYPERIONPATH
$PM2 start --only "$INDEXER" --update-env --silent
$PM2 save
