param(
    [Parameter(Mandatory)][ValidateSet('create','cleanup')][string]$Action,
    [Parameter(Mandatory)][string]$StateFile,
    [switch]$ExposeRabbitManagement,
    # Broker-restart qualification needs the configured endpoints to survive a container restart.
    [switch]$PinRabbitPorts,
    # Pressure qualification keeps its one-MiB default. Actual source journals can require larger individual writes.
    [ValidateRange(1,256)][int]$IndexingPressureLimitMb=1
)
$ErrorActionPreference='Stop'
$label='es198-replicas'
if ($PinRabbitPorts -and ($Action -ne 'create' -or -not $ExposeRabbitManagement)) {
    throw 'Pinned Rabbit ports require create with exposed management'
}
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
        network=$network;nodes=@();broker=$null;status='creating';indexingPressureLimitMb=$IndexingPressureLimitMb}
    Save-State $state
    $null=Invoke-FixtureDocker @('network','create','--label',"io.eosrio.qualifier=$label",'--label',"io.eosrio.run=$run",$network)
    $names=@("$network-a","$network-b","$network-witness")
    foreach ($position in 0..2) {
        $name=$names[$position]; $volume="$name-data"; $data=$position -lt 2
        $entry=@{name=$name;role=if($data){'data'}else{'master'};containerId=$null;volume=$volume;url=$null}
        $state.nodes+=@($entry); Save-State $state
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
            '-e','ingest.geoip.downloader.enabled=false','-e',"indexing_pressure.memory.limit=$($IndexingPressureLimitMb)mb",
            '-e','cluster.routing.allocation.disk.watermark.low=20gb','-e','cluster.routing.allocation.disk.watermark.high=10gb',
            '-e','cluster.routing.allocation.disk.watermark.flood_stage=5gb','-e',"ES_JAVA_OPTS=-Xms$heap -Xmx$heap",$state.esImage)
        $cid=(Invoke-FixtureDocker $args).Trim()
        $entry.containerId=$cid; Save-State $state
        $url='http://'+(Invoke-FixtureDocker @('port',$cid,'9200/tcp')).Trim()
        $entry.url=$url; $entry.heap=$heap; $entry.memory=$memory; $entry.cpus=$cpus; $entry.dockerArgs=$args
        Save-State $state
    }
    $brokerName="$network-rabbit"; $brokerVolume="$brokerName-data"
    $state.broker=@{name=$brokerName;containerId=$null;volume=$brokerVolume;url=$null}; Save-State $state
    $null=Invoke-FixtureDocker @('volume','create','--label',"io.eosrio.qualifier=$label",'--label',"io.eosrio.run=$run",$brokerVolume)
    $leases=@(); $pinnedPorts=$null
    try {
        if ($PinRabbitPorts) {
            # Keep both leases until immediately before Docker binds them. A competing bind fails creation;
            # do not retry on different ports after recording the endpoint intent.
            foreach ($unused in 1..2) {
                $lease=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
                $leases+=@($lease); $lease.ExclusiveAddressUse=$true; $lease.Start()
            }
            $pinnedPorts=@{amqp=$leases[0].LocalEndpoint.Port;management=$leases[1].LocalEndpoint.Port}
            $state.broker.pinnedPorts=$pinnedPorts; Save-State $state
        }
        $amqpBinding=if($PinRabbitPorts){"127.0.0.1:$($pinnedPorts.amqp):5672"}else{'127.0.0.1::5672'}
        $brokerArgs=@('run','-d','--name',$brokerName,'--hostname',$brokerName,'--network',$network,
            '--label',"io.eosrio.qualifier=$label",'--label',"io.eosrio.run=$run",'--cpus','1','--memory','1g',
            '-p',$amqpBinding,'--mount',"type=volume,src=$brokerVolume,dst=/var/lib/rabbitmq",
            '-e','RABBITMQ_DEFAULT_USER=qualifier','-e','RABBITMQ_DEFAULT_PASS=qualifier-test-only')
        if ($ExposeRabbitManagement) {
            $managementBinding=if($PinRabbitPorts){"127.0.0.1:$($pinnedPorts.management):15672"}else{'127.0.0.1::15672'}
            $brokerArgs+=@('-p',$managementBinding)
        }
        $brokerArgs+=@($state.rabbitImage)
        foreach ($lease in $leases) { $lease.Stop() }
        $brokerId=(Invoke-FixtureDocker $brokerArgs).Trim()
    } finally { foreach ($lease in $leases) { $lease.Stop() } }
    $state.broker.containerId=$brokerId; Save-State $state
    $brokerHost=(Invoke-FixtureDocker @('port',$brokerId,'5672/tcp')).Trim()
    $state.broker=@{name=$brokerName;containerId=$brokerId;volume=$brokerVolume;
        url="amqp://qualifier:qualifier-test-only@$brokerHost";dockerArgs=$brokerArgs}
    if ($PinRabbitPorts) { $state.broker.pinnedPorts=$pinnedPorts }
    if ($ExposeRabbitManagement) {
        $state.broker.managementUrl='http://'+(Invoke-FixtureDocker @('port',$brokerId,'15672/tcp')).Trim()
    }
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
$resources=@(@($state.nodes)+@($state.broker) | Where-Object { $_ })
$containerInventory=@(Invoke-FixtureDocker @('ps','-a','--no-trunc','--filter',"label=io.eosrio.run=$($state.run)",'--format','{{.ID}}|{{.Names}}'))
$volumeInventory=@(Invoke-FixtureDocker @('volume','ls','--filter',"label=io.eosrio.run=$($state.run)",'--format','{{.Name}}'))
$containers=@(); $volumes=@()
foreach ($item in $resources) {
    if ($item.name -notin @("$($state.network)-a","$($state.network)-b","$($state.network)-witness","$($state.network)-rabbit") -or $item.volume -ne "$($item.name)-data") { throw 'Unexpected resource intent' }
    $matching=@($containerInventory | Where-Object { $_.Split('|',2)[1] -eq $item.name })
    if ($matching.Count -gt 1) { throw 'Ambiguous container identity' }
    $cid=if($matching.Count){$matching[0].Split('|',2)[0]}else{$null}
    if ($cid) {
        if ($item.containerId -and $cid -ne $item.containerId) { throw 'Container identity changed' }
        $ins=@((Invoke-FixtureDocker @('inspect',$cid)) | ConvertFrom-Json)[0]
        Assert-Labels $ins.Config.Labels $state.run
        if ($ins.Name -ne '/'+$item.name) { throw 'Container name changed' }
        $containers+=@($cid)
    }
    if ($item.volume -in $volumeInventory) {
        $volume=@((Invoke-FixtureDocker @('volume','inspect',$item.volume)) | ConvertFrom-Json)[0]
        Assert-Labels $volume.Labels $state.run
        $users=@(Invoke-FixtureDocker @('ps','-a','--no-trunc','--filter',"volume=$($item.volume)",'--format','{{.ID}}'))
        if ($users.Count -gt 1 -or ($users.Count -eq 1 -and $users[0] -ne $cid)) { throw 'Unexpected volume consumer' }
        $volumes+=@($item.volume)
    }
}
if ($containers.Count -ne $containerInventory.Count -or $volumes.Count -ne $volumeInventory.Count) { throw 'Unplanned run-labelled resources; preserve for inspection' }
$networkPresent=$state.network -in @(Invoke-FixtureDocker @('network','ls','--filter',"label=io.eosrio.run=$($state.run)",'--format','{{.Name}}'))
if ($networkPresent) {
    $network=@((Invoke-FixtureDocker @('network','inspect',$state.network)) | ConvertFrom-Json)[0]
    Assert-Labels $network.Labels $state.run
    foreach ($property in @($network.Containers.psobject.Properties)) {
        if ($property.Name -notin $containers) { throw 'Unexpected network consumer' }
    }
}
$receipt=[ordered]@{run=$state.run;inspectedAt=[DateTime]::UtcNow.ToString('o');containers=@();volumes=@();network=$state.network}
foreach ($cid in $containers) { $null=Invoke-FixtureDocker @('rm','--force',$cid); $receipt.containers+=@($cid) }
foreach ($volume in $volumes) { $null=Invoke-FixtureDocker @('volume','rm',$volume); $receipt.volumes+=@($volume) }
if ($networkPresent) { $null=Invoke-FixtureDocker @('network','rm',$state.network) }
$receipt.remainingContainers=@(Invoke-FixtureDocker @('ps','-a','--filter',"label=io.eosrio.run=$($state.run)",'--format','{{.ID}}')).Count
$receipt.remainingVolumes=@(Invoke-FixtureDocker @('volume','ls','--filter',"label=io.eosrio.run=$($state.run)",'--format','{{.Name}}')).Count
$receipt.remainingNetworks=@(Invoke-FixtureDocker @('network','ls','--filter',"label=io.eosrio.run=$($state.run)",'--format','{{.ID}}')).Count
if ($receipt.remainingContainers -or $receipt.remainingVolumes -or $receipt.remainingNetworks) { throw 'Fixture cleanup residue' }
$receipt.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($StateFile+'.cleanup.json',($receipt|ConvertTo-Json -Depth 10)+"`n",[Text.UTF8Encoding]::new($false))
Write-Output 'Removed exact owned fixture containers, volumes and network'
