from elasticsearch import Elasticsearch
import re
import subprocess
from subprocess import Popen, PIPE, STDOUT
from sh import tail
import time
import sys


# Import that you stop the indexer before you start running this script

if len(sys.argv) != 2:
    raise ValueError('Please provide Elastic username, password and Elastic IP address. http://elastic:password@127.0.0.1')
elasticnode = sys.argv[1]+":9200/"

es = Elasticsearch(
    [
        elasticnode
    ],
    verify_certs=True
)

class bcolors:
    HEADER = '\033[95m'
    OKYELLOW = '\033[93m'
    OKGREEN = '\033[92m'
    OKBLUE = '\033[94m'
    WARNING = '\033[91m'
    FAIL = '\033[91m'
    ENDC = '\033[0m'
    BOLD = '\033[1m'
    UNDERLINE = '\033[4m'

# For testing purposes
testing = [{'gt': 114688000.0, 'lt': 114688999.0, 'doc_count': 989}, {'gt': 115153000.0, 'lt': 115153999.0, 'doc_count': 994}, {'gt': 116634000.0, 'lt': 116634999.0, 'doc_count': 995}, {'gt': 116712000.0, 'lt': 116712999.0, 'doc_count': 994}, {'gt': 116851000.0, 'lt': 116851999.0, 'doc_count': 995}, {'gt': 117153000.0, 'lt': 117153999.0, 'doc_count': 993}, {'gt': 117419000.0, 'lt': 117419999.0, 'doc_count': 995}, {'gt': 117443000.0, 'lt': 117443999.0, 'doc_count': 993}, {'gt': 117444000.0, 'lt': 117444999.0, 'doc_count': 992}, {'gt': 117481000.0, 'lt': 117481999.0, 'doc_count': 989}, {'gt': 117515000.0, 'lt': 117515999.0, 'doc_count': 996}, {'gt': 117547000.0, 'lt': 117547999.0, 'doc_count': 993}, {'gt': 117578000.0, 'lt': 117578999.0, 'doc_count': 993}, {'gt': 117614000.0, 'lt': 117614999.0, 'doc_count': 996}, {'gt': 117650000.0, 'lt': 117650999.0, 'doc_count': 995}, {'gt': 117683000.0, 'lt': 117683999.0, 'doc_count': 994}, {'gt': 117717000.0, 'lt': 117717999.0, 'doc_count': 995}, {'gt': 117750000.0, 'lt': 117750999.0, 'doc_count': 998}, {'gt': 117787000.0, 'lt': 117787999.0, 'doc_count': 991}, {'gt': 117821000.0, 'lt': 117821999.0, 'doc_count': 992}, {'gt': 117851000.0, 'lt': 117851999.0, 'doc_count': 991}, {'gt': 117888000.0, 'lt': 117888999.0, 'doc_count': 991}, {'gt': 117918000.0, 'lt': 117918999.0, 'doc_count': 993}, {'gt': 117949000.0, 'lt': 117949999.0, 'doc_count': 997}, {'gt': 117980000.0, 'lt': 117980999.0, 'doc_count': 994}, {'gt': 118008000.0, 'lt': 118008999.0, 'doc_count': 998}, {'gt': 118069000.0, 'lt': 118069999.0, 'doc_count': 995}, {'gt': 118107000.0, 'lt': 118107999.0, 'doc_count': 999}, {'gt': 118141000.0, 'lt': 118141999.0, 'doc_count': 991}, {'gt': 118172000.0, 'lt': 118172999.0, 'doc_count': 998}, {'gt': 118206000.0, 'lt': 118206999.0, 'doc_count': 994}, {'gt': 118212000.0, 'lt': 118212999.0, 'doc_count': 994}, {'gt': 118247000.0, 'lt': 118247999.0, 'doc_count': 996}, {'gt': 118277000.0, 'lt': 118277999.0, 'doc_count': 992}, {'gt': 118309000.0, 'lt': 118309999.0, 'doc_count': 997}, {'gt': 118341000.0, 'lt': 118341999.0, 'doc_count': 997}, {'gt': 118375000.0, 'lt': 118375999.0, 'doc_count': 986}, {'gt': 118408000.0, 'lt': 118408999.0, 'doc_count': 999}, {'gt': 118487000.0, 'lt': 118487999.0, 'doc_count': 998}, {'gt': 118518000.0, 'lt': 118518999.0, 'doc_count': 995}, {'gt': 118555000.0, 'lt': 118555999.0, 'doc_count': 995}, {'gt': 118589000.0, 'lt': 118589999.0, 'doc_count': 993}, {'gt': 118621000.0, 'lt': 118621999.0, 'doc_count': 995}, {'gt': 118625000.0, 'lt': 118625999.0, 'doc_count': 998}, {'gt': 118655000.0, 'lt': 118655999.0, 'doc_count': 995}, {'gt': 118685000.0, 'lt': 118685999.0, 'doc_count': 995}, {'gt': 118719000.0, 'lt': 118719999.0, 'doc_count': 993}, {'gt': 118753000.0, 'lt': 118753999.0, 'doc_count': 999}, {'gt': 118788000.0, 'lt': 118788999.0, 'doc_count': 996}, {'gt': 118823000.0, 'lt': 118823999.0, 'doc_count': 992}, {'gt': 118857000.0, 'lt': 118857999.0, 'doc_count': 995}, {'gt': 118864000.0, 'lt': 118864999.0, 'doc_count': 994}, {'gt': 118953000.0, 'lt': 118953999.0, 'doc_count': 998}, {'gt': 119026000.0, 'lt': 119026999.0, 'doc_count': 994}, {'gt': 119068000.0, 'lt': 119068999.0, 'doc_count': 997}, {'gt': 119107000.0, 'lt': 119107999.0, 'doc_count': 994}, {'gt': 119148000.0, 'lt': 119148999.0, 'doc_count': 997}, {'gt': 119190000.0, 'lt': 119190999.0, 'doc_count': 995}, {'gt': 119231000.0, 'lt': 119231999.0, 'doc_count': 996}, {'gt': 119273000.0, 'lt': 119273999.0, 'doc_count': 997}, {'gt': 119314000.0, 'lt': 119314999.0, 'doc_count': 999}, {'gt': 119351000.0, 'lt': 119351999.0, 'doc_count': 996}, {'gt': 119387000.0, 'lt': 119387999.0, 'doc_count': 993}, {'gt': 119427000.0, 'lt': 119427999.0, 'doc_count': 995}, {'gt': 119468000.0, 'lt': 119468999.0, 'doc_count': 996}, {'gt': 119507000.0, 'lt': 119507999.0, 'doc_count': 998}, {'gt': 119548000.0, 'lt': 119548999.0, 'doc_count': 997}, {'gt': 119567000.0, 'lt': 119567999.0, 'doc_count': 996}, {'gt': 119632000.0, 'lt': 119632999.0, 'doc_count': 997}, {'gt': 119664000.0, 'lt': 119664999.0, 'doc_count': 998}, {'gt': 119679000.0, 'lt': 119679999.0, 'doc_count': 999}, {'gt': 119685000.0, 'lt': 119685999.0, 'doc_count': 998}, {'gt': 119688000.0, 'lt': 119688999.0, 'doc_count': 992}, {'gt': 119694000.0, 'lt': 119694999.0, 'doc_count': 996}, {'gt': 119695000.0, 'lt': 119695999.0, 'doc_count': 997}, {'gt': 119703000.0, 'lt': 119703999.0, 'doc_count': 998}, {'gt': 119731000.0, 'lt': 119731999.0, 'doc_count': 995}, {'gt': 119733000.0, 'lt': 119733999.0, 'doc_count': 999}, {'gt': 119737000.0, 'lt': 119737999.0, 'doc_count': 990}, {'gt': 119754000.0, 'lt': 119754999.0, 'doc_count': 999}, {'gt': 119777000.0, 'lt': 119777999.0, 'doc_count': 985}, {'gt': 119807000.0, 'lt': 119807999.0, 'doc_count': 998}, {'gt': 119810000.0, 'lt': 119810999.0, 'doc_count': 996}, {'gt': 119828000.0, 'lt': 119828999.0, 'doc_count': 997}, {'gt': 119866000.0, 'lt': 119866999.0, 'doc_count': 993}, {'gt': 120000000.0, 'lt': 120000999.0, 'doc_count': 1}, {'gt': 120088000.0, 'lt': 120088999.0, 'doc_count': 998}, {'gt': 120090000.0, 'lt': 120090999.0, 'doc_count': 992}, {'gt': 120102000.0, 'lt': 120102999.0, 'doc_count': 998}, {'gt': 120103000.0, 'lt': 120103999.0, 'doc_count': 983}, {'gt': 120109000.0, 'lt': 120109999.0, 'doc_count': 995}, {'gt': 120110000.0, 'lt': 120110999.0, 'doc_count': 997}, {'gt': 120228000.0, 'lt': 120228999.0, 'doc_count': 994}, {'gt': 120238000.0, 'lt': 120238999.0, 'doc_count': 998}, {'gt': 120239000.0, 'lt': 120239999.0, 'doc_count': 995}, {'gt': 120243000.0, 'lt': 120243999.0, 'doc_count': 997}, {'gt': 120247000.0, 'lt': 120247999.0, 'doc_count': 776}, {'gt': 120248000.0, 'lt': 120248999.0, 'doc_count': 607}, {'gt': 120249000.0, 'lt': 120249999.0, 'doc_count': 500}, {'gt': 120250000.0, 'lt': 120250999.0, 'doc_count': 979}, {'gt': 120253000.0, 'lt': 120253999.0, 'doc_count': 733}, {'gt': 120254000.0, 'lt': 120254999.0, 'doc_count': 251}, {'gt': 120255000.0, 'lt': 120255999.0, 'doc_count': 249}, {'gt': 120256000.0, 'lt': 120256999.0, 'doc_count': 251}, {'gt': 120257000.0, 'lt': 120257999.0, 'doc_count': 249}, {'gt': 120258000.0, 'lt': 120258999.0, 'doc_count': 250}, {'gt': 120259000.0, 'lt': 120259999.0, 'doc_count': 250}, {'gt': 120260000.0, 'lt': 120260999.0, 'doc_count': 250}, {'gt': 120261000.0, 'lt': 120261999.0, 'doc_count': 251}, {'gt': 120262000.0, 'lt': 120262999.0, 'doc_count': 249}, {'gt': 120263000.0, 'lt': 120263999.0, 'doc_count': 250}, {'gt': 120264000.0, 'lt': 120264999.0, 'doc_count': 250}, {'gt': 120265000.0, 'lt': 120265999.0, 'doc_count': 251}, {'gt': 120266000.0, 'lt': 120266999.0, 'doc_count': 250}, {'gt': 120267000.0, 'lt': 120267999.0, 'doc_count': 250}, {'gt': 120268000.0, 'lt': 120268999.0, 'doc_count': 250}, {'gt': 120269000.0, 'lt': 120269999.0, 'doc_count': 555}, {'gt': 125010000.0, 'lt': 125010999.0, 'doc_count': 997}, {'gt': 137832000.0, 'lt': 137832999.0, 'doc_count': 948}, {'gt': 137833000.0, 'lt': 137833999.0, 'doc_count': 997}, {'gt': 137834000.0, 'lt': 137834999.0, 'doc_count': 870}, {'gt': 137835000.0, 'lt': 137835999.0, 'doc_count': 815}, {'gt': 137837000.0, 'lt': 137837999.0, 'doc_count': 908}, {'gt': 137838000.0, 'lt': 137838999.0, 'doc_count': 900}, {'gt': 137914000.0, 'lt': 137914999.0, 'doc_count': 265}, {'gt': 137922000.0, 'lt': 137922999.0, 'doc_count': 706}, {'gt': 137941000.0, 'lt': 137941999.0, 'doc_count': 559}, {'gt': 137832000.0, 'lt': 137832999.0, 'doc_count': 948}, {'gt': 137833000.0, 'lt': 137833999.0, 'doc_count': 997}, {'gt': 137834000.0, 'lt': 137834999.0, 'doc_count': 870}, {'gt': 137835000.0, 'lt': 137835999.0, 'doc_count': 815}, {'gt': 137837000.0, 'lt': 137837999.0, 'doc_count': 908}, {'gt': 137838000.0, 'lt': 137838999.0, 'doc_count': 900}, {'gt': 137914000.0, 'lt': 137914999.0, 'doc_count': 265}, {'gt': 137922000.0, 'lt': 137922999.0, 'doc_count': 706}, {'gt': 137941000.0, 'lt': 137941999.0, 'doc_count': 559}]
# Regex
start_on = '.start_on.*'
stop_on = '.stop_on.*'
live_reader = '.live_reader.*'
rewrite = '.rewrite.*'


shutting_down = r'.*Shutting down master.*'
offline = r'.*(offline or unexistent)'
lastblock_indexed = r'.*Last Indexed Block:.* (\d*)'  #group the last block indexed for reference.


# Config 
filepath="/opt/eosio/src/Hyperion-History-API/chains/proton.config.json"
indexer_stop = ["pm2", "trigger", "proton-indexer", "stop"]
indexer_start = ["./run.sh", "proton-indexer"]
indexer_log_file = "/home/eosio/.pm2/logs/proton-indexer-out.log"
tail_indexer_logs = ["tail","-f", indexer_log_file]
hyperion_version = '3.3'  #'3.1' or '3.3'


# No blocks being processed differs between 3.3 and 3.1
if hyperion_version == '3.3':
    no_blocks_processed = r'.*No blocks are being processed.*'
else:
    no_blocks_processed = r'.*No blocks processed.*'



def query_body(interval):
    query_body = {
    "aggs": {
        "block_histogram": {
        "histogram": {
            "field": "block_num",
            "interval": interval,
            "min_doc_count": 1
        },
        "aggs": {
            "max_block": {
            "max": {
                "field": "block_num"
            }
            }
        }
        }
    },
    "size": 0,
    "query": {
        "match_all": {}
    }
    }
    return query_body

def query_body2(gte,lte,interval):
    query = {
            "aggs": {
                "block_histogram": {
                "histogram": {
                    "field": "block_num",
                    "interval": interval,
                    "min_doc_count": 1
                },
                "aggs": {
                    "max_block": {
                    "max": {
                        "field": "block_num"
                    }
                    }
                }
                }
            },
            "size": 0,
            "query": {
                "bool": {
                "must": [
                    {
                    "range": {
                        "block_num": {
                        "gte": gte,
                        "lte": lte
                        }
                    }
                    }
                ]
                }
            }
            }
    return query



# Search and return buckets
def get_buckets(interval, query):
    query = query(interval)
    result = es.search(index="proton-block-*", body=query)
    buckets = result['aggregations']['block_histogram']['buckets']
    return buckets

# Find buckets with missing blocks
def buckets_missing(bucketlist,count1,count2): 
    buckets_final = []
    bucketdict = {}
    for num, bucket in enumerate(bucketlist):
        # Create copy of dict and call it new
        new = bucketdict.copy()
        key = bucket['key']
        doc_count = bucket['doc_count']
        # Check if count is less than
        if num == 0 and doc_count < count1:
            new.update({'key': key, 'doc_count': doc_count})
            buckets_final.append(new)
        # If not first bucket but has less than count2
        elif doc_count < count2 and num != 0:
            new.update({'key': key, 'doc_count': doc_count})
            buckets_final.append(new)
    return buckets_final


# Find and replace text
def replacement(Path, text, subs, flags=0):
  with open(filepath, "r+") as f1:
       contents = f1.read()
       pattern =  re.compile(text, flags)
       contents = pattern.sub(subs, contents)
       f1.seek(0)
       f1.truncate()
       f1.write(contents)


# Build text patterns
def buildReplacementText(key,value):
  subs = '"'+str(key)+'": '+str(value)+','
  return subs


def MagicFuzz(missing):
    for num, missed in enumerate(missing):
        gt = str(int(missed['gt']))
        lt = str(int(missed['lt']))
        print(bcolors.OKYELLOW,f"{'='*100}\n1.Building replacement text for config file ",bcolors.ENDC)
        subs_start = buildReplacementText('start_on',gt)
        subs_stop = buildReplacementText('stop_on',lt)
        live_reader_k = buildReplacementText('live_reader','false')
        rewrite_k = buildReplacementText('rewrite','true')
        print(bcolors.OKYELLOW,f"{'='*100}\n2.Updating the config file ",bcolors.ENDC)
        replacement(filepath, start_on, subs_start)
        replacement(filepath, stop_on, subs_stop)
        replacement(filepath, live_reader, live_reader_k)
        replacement(filepath, rewrite, rewrite_k)
        print(bcolors.OKYELLOW,f"{'='*100}\n3.Config file is now updated for: ",gt,"-",lt,bcolors.ENDC)
        print(bcolors.OKYELLOW,f"{'='*100}\n4.Running Re-indexing for: ",gt,"-",lt,bcolors.ENDC)
        startRewrite(gt,lt)
        time.sleep(0.1)
    print(bcolors.OKYELLOW,f"{'='*100}\nRe-indexing Complete ",gt,"-",lt,bcolors.ENDC)
    exit


def spinning_cursor(run):
  while run == True:
    for cursor in '\\|/-':
      time.sleep(0.1)
      # Use '\r' to move cursor back to line beginning
      # Or use '\b' to erase the last character
      sys.stdout.write('\r{}'.format(cursor))
      # Force Python to write data into terminal.
      sys.stdout.flush()

def startRewrite(gt,lt):
    run = Popen(indexer_start,stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(10)
    logtail = Popen(tail_indexer_logs, stdin=PIPE, stdout=PIPE, stderr=STDOUT) 
    completedcount = 0
    for linenum, line in enumerate(logtail.stdout):
        #spinning_cursor(True)
        # decode line from bytes-object
        line = line.decode('utf-8')
        print(line)
        completed = re.match(no_blocks_processed, line)
        shutdown = re.match(shutting_down, line)
        lastblock = re.match(lastblock_indexed, line)
        if not completedcount > 0 and completed:
            print(bcolors.OKYELLOW,f"{'='*100}\n5.Shutting down indexer: ",bcolors.ENDC)
            subprocess.run(indexer_stop,stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            # Increment completed count as regex shows up multipletimes. To not try and send shutdown command multiple times.
            completedcount += 1
            #Try without sleep and break
            # Sleep process to wait for indexer to shutdown
            #time.sleep(15)
            #break
        elif lastblock:
             # Indicates indexer has already shutdown, break out of loop and restart process.
             print(bcolors.OKYELLOW,f"{'='*100}\n6.Indexer shutdown: ",bcolors.ENDC)
             break  
        elif shutdown:
            # If indexer already shutdown, break out of loop and restart process.
            print(bcolors.OKYELLOW,f"{'='*100}\n6.Indexer shutdown: ",bcolors.ENDC)
            #spinning_cursor(False)
            break
        else:
            continue


# Create greater, less than lists.
def CreateGtLT(missing):
    lte = 10000000
    buckets_final = []
    bucketdict = {}
    for num, bucket in enumerate(missing):
        gte = bucket['key']
        lte = gte+lte
        result = es.search(index="proton-block-*", body=query_body2(gte,lte,1000))
        buckets = result['aggregations']['block_histogram']['buckets']
        # Search for missing buckets with less than 1000
        missing = buckets_missing(buckets,1000,1000)
        for bucket in missing:
            new = bucketdict.copy()
            doc_count = bucket['doc_count']
            gt = bucket['key']
            lt = gt+1000
            new.update({'gt': gt, 'lt': lt, 'doc_count': doc_count})
            buckets_final.append(new)
    return buckets_final

def start_indexer_live():
    print('Live indexer startig again')
    subs_start = buildReplacementText('start_on',0)
    subs_stop = buildReplacementText('stop_on',0)
    live_reader_k = buildReplacementText('live_reader','true')
    rewrite_k = buildReplacementText('rewrite','false')
    replacement(filepath, start_on, subs_start)
    replacement(filepath, stop_on, subs_stop)
    replacement(filepath, live_reader, live_reader_k)
    replacement(filepath, rewrite, rewrite_k)
    run = Popen(indexer_start,stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

if __name__ == '__main__':
    # Shutdown indexer if running
    subprocess.run(indexer_stop,stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(bcolors.OKYELLOW,f"{'='*100}\nSearching for missing Blocks ",bcolors.ENDC)
    # Search for buckets using histogram interval
    buckets = get_buckets(10000000,query_body)
    # Get buckets with missing blocks, first count is 9999999 to account for bucket 0-9999999.
    missing = buckets_missing(buckets,9999999,10000000 )
    # Redefine search and set interval to 1000
    gt_lt_list = CreateGtLT(missing)
    print(bcolors.OKYELLOW,f"{'='*100}\nCompleted Search ",bcolors.ENDC)
    #### For testing purposes use  MagicFuzz(testing)
    MagicFuzz(gt_lt_list)
    ## Once rewrite is completed go back to live reading
    start_indexer_live()
