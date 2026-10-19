param(
    [Parameter(Mandatory)][ValidateSet('create','cleanup')][string]$Action,
    [Parameter(Mandatory)][string]$StateFile
)
$ErrorActionPreference='Stop'
$label='es198-replicas'
function Invoke-FixtureDocker([string[]]$Arguments) {
    $result=& docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker failed: $($Arguments[0])" }
    return $result
}
function Save-State($State) {
    [IO.File]::WriteAllText($StateFile,($State | ConvertTo-Json -Depth 20)+"`n",[Text.UTF8Encoding]::new($false))
}
function Assert-Labels($Resource,$Run) {
    if ($Resource.'io.eosrio.qualifier' -ne $label -or $Resource.'io.eosrio.run' -ne $Run) { throw 'Fixture ownership mismatch' }
}
if ($Action -eq 'create') {
    if (Test-Path -LiteralPath $StateFile) { throw 'Refusing to replace fixture state' }
    $run=([guid]::NewGuid().ToString('N')).Substring(0,12)
    $network="hyp-es955-replicas-$run"
    $state=[ordered]@{schemaVersion=1;run=$run;clusterName="hyperion-es198-$run";createdAt=[DateTime]::UtcNow.ToString('o');
        esImage='docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c';
        rabbitImage='rabbitmq@sha256:09b39ca8a3e884e91cab8842cd41264de21aab0625e1f1d016a9a3135ba590ef';
        network=$network;nodes=@();broker=$null;status='creating'}
    Save-State $state
    $null=Invoke-FixtureDocker @('network','create','--label',"io.eosrio.qualifier=$label",'--label',"io.eosrio.run=$run",$network)
    $names=@("$network-a","$network-b","$network-witness")
    foreach ($position in 0..2) {
        $name=$names[$position]; $volume="$name-data"; $data=$position -lt 2
        $null=Invoke-FixtureDocker @('volume','create','--label',"io.eosrio.qualifier=$label",'--label',"io.eosrio.run=$run",$volume)
        $heap=if($data){'1g'}else{'512m'}
        $roles=if($data){'master,data,ingest'}else{'master'}
        $memory=if($data){'3g'}else{'1536m'}
        $cpus=if($data){'2'}else{'1'}
        $args=@('run','-d','--name',$name,'--hostname',$name,'--network',$network,
            '--label',"io.eosrio.qualifier=$label",'--label',"io.eosrio.run=$run",'--cpus',$cpus,'--memory',$memory,
            '-p','127.0.0.1::9200','--mount',"type=volume,src=$volume,dst=/usr/share/elasticsearch/data",
            '-e',"cluster.name=$($state.clusterName)",'-e',"node.name=$name",'-e',"node.roles=$roles",
            '-e',"discovery.seed_hosts=$($names -join ',')",'-e',"cluster.initial_master_nodes=$($names -join ',')",
            '-e','xpack.security.enabled=false','-e','xpack.security.autoconfiguration.enabled=false','-e','xpack.ml.enabled=false',
            '-e','ingest.geoip.downloader.enabled=false','-e','indexing_pressure.memory.limit=1mb',
            '-e','cluster.routing.allocation.disk.watermark.low=20gb','-e','cluster.routing.allocation.disk.watermark.high=10gb',
            '-e','cluster.routing.allocation.disk.watermark.flood_stage=5gb','-e',"ES_JAVA_OPTS=-Xms$heap -Xmx$heap",$state.esImage)
        $cid=(Invoke-FixtureDocker $args).Trim()
        $url='http://'+(Invoke-FixtureDocker @('port',$cid,'9200/tcp')).Trim()
        $state.nodes+=@{name=$name;role=if($data){'data'}else{'master'};containerId=$cid;volume=$volume;url=$url;
            heap=$heap;memory=$memory;cpus=$cpus;dockerArgs=$args}
        Save-State $state
    }
    $brokerName="$network-rabbit"; $brokerVolume="$brokerName-data"
    $null=Invoke-FixtureDocker @('volume','create','--label',"io.eosrio.qualifier=$label",'--label',"io.eosrio.run=$run",$brokerVolume)
    $brokerArgs=@('run','-d','--name',$brokerName,'--hostname',$brokerName,'--network',$network,
        '--label',"io.eosrio.qualifier=$label",'--label',"io.eosrio.run=$run",'--cpus','1','--memory','1g',
        '-p','127.0.0.1::5672','--mount',"type=volume,src=$brokerVolume,dst=/var/lib/rabbitmq",
        '-e','RABBITMQ_DEFAULT_USER=qualifier','-e','RABBITMQ_DEFAULT_PASS=qualifier-test-only',$state.rabbitImage)
    $brokerId=(Invoke-FixtureDocker $brokerArgs).Trim()
    $brokerHost=(Invoke-FixtureDocker @('port',$brokerId,'5672/tcp')).Trim()
    $state.broker=@{name=$brokerName;containerId=$brokerId;volume=$brokerVolume;
        url="amqp://qualifier:qualifier-test-only@$brokerHost";dockerArgs=$brokerArgs}
    Save-State $state
    $deadline=[DateTime]::UtcNow.AddSeconds(90)
    do {
        try {
            $infos=@($state.nodes | ForEach-Object { Invoke-RestMethod $_.url -TimeoutSec 2 })
            if (@($infos | Where-Object { $_.cluster_name -ne $state.clusterName -or $_.version.number -ne '9.5.5' }).Count) { throw 'Identity mismatch' }
            $uuids=@($infos.cluster_uuid | Sort-Object -Unique)
            $health=Invoke-RestMethod "$($state.nodes[0].url)/_cluster/health" -TimeoutSec 2
            if ($uuids.Count -ne 1 -or $uuids[0] -eq '_na_' -or $health.number_of_nodes -ne 3) { throw 'Cluster not formed' }
            $state.clusterUuid=$uuids[0]; $state.status='ready'; Save-State $state
            Write-Output "Ready $($state.clusterName) $($state.clusterUuid)"
            exit 0
        } catch { Start-Sleep -Milliseconds 500 }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Fixture did not become ready; preserved state allows exact cleanup'
}
$state=Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
if ($state.run -notmatch '^[a-f0-9]{12}$' -or $state.network -ne "hyp-es955-replicas-$($state.run)") { throw 'Invalid fixture state' }
$resources=@($state.nodes)+@($state.broker)
foreach ($item in $resources) {
    if (-not $item) { continue }
    $ins=@((Invoke-FixtureDocker @('inspect',$item.containerId)) | ConvertFrom-Json)[0]
    Assert-Labels $ins.Config.Labels $state.run
    $volume=@((Invoke-FixtureDocker @('volume','inspect',$item.volume)) | ConvertFrom-Json)[0]
    Assert-Labels $volume.Labels $state.run
    $users=@(Invoke-FixtureDocker @('ps','-a','--no-trunc','--filter',"volume=$($item.volume)",'--format','{{.ID}}'))
    if ($users.Count -ne 1 -or $users[0] -ne $item.containerId) { throw 'Unexpected volume consumer' }
}
$network=@((Invoke-FixtureDocker @('network','inspect',$state.network)) | ConvertFrom-Json)[0]
Assert-Labels $network.Labels $state.run
if (@($network.Containers.psobject.Properties).Count -gt $resources.Count) { throw 'Unexpected network consumer' }
$receipt=[ordered]@{run=$state.run;inspectedAt=[DateTime]::UtcNow.ToString('o');containers=@();volumes=@();network=$state.network}
foreach ($item in $resources) {
    if (-not $item) { continue }
    $null=Invoke-FixtureDocker @('rm','--force',$item.containerId); $receipt.containers+=@($item.containerId)
    $null=Invoke-FixtureDocker @('volume','rm',$item.volume); $receipt.volumes+=@($item.volume)
}
$null=Invoke-FixtureDocker @('network','rm',$state.network)
$receipt.remainingContainers=@(Invoke-FixtureDocker @('ps','-a','--filter',"label=io.eosrio.run=$($state.run)",'--format','{{.ID}}')).Count
$receipt.remainingVolumes=@(Invoke-FixtureDocker @('volume','ls','--filter',"label=io.eosrio.run=$($state.run)",'--format','{{.Name}}')).Count
$receipt.remainingNetworks=@(Invoke-FixtureDocker @('network','ls','--filter',"label=io.eosrio.run=$($state.run)",'--format','{{.ID}}')).Count
if ($receipt.remainingContainers -or $receipt.remainingVolumes -or $receipt.remainingNetworks) { throw 'Fixture cleanup residue' }
$receipt.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($StateFile+'.cleanup.json',($receipt|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
Write-Output 'Removed exact owned fixture containers, volumes and network'
