param(
    [Parameter(Mandatory)][ValidateSet('create','cleanup')][string]$Action,
    [Parameter(Mandatory)][string]$StateFile
)
$ErrorActionPreference='Stop'
$StateFile=[IO.Path]::GetFullPath($StateFile)
$coreScript=Join-Path $PSScriptRoot 'es955-replica-fixture.ps1'
$coreStateFile=$StateFile+'.core.json'
$extraLabel='es198-workers'
$redisImage='redis@sha256:978f0e01593e65eed801f2402944efcd936d43b5027e4908a7897baf88ed6241'
$mongoImage='mongo@sha256:4968f22d0c6c10ef29952f3e807f62872ba22b3312f25803564fbfc08255efc2'
$springImage='igorls/spring-nodeos@sha256:13130dbeeaf519209d8aec8b79edfa14ee3e1de958f461506b63569a91714c5a'
function Invoke-WorkerDocker([string[]]$Arguments) {
    $result=& docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker failed: $($Arguments[0])" }
    return $result
}
function Save-WorkerState($State) {
    [IO.File]::WriteAllText($StateFile,($State | ConvertTo-Json -Depth 30)+"`n",[Text.UTF8Encoding]::new($false))
}
function Assert-WorkerLabels($Labels,$Run,$Label) {
    if ($Labels.'io.eosrio.qualifier' -ne $Label -or $Labels.'io.eosrio.run' -ne $Run) { throw 'Fixture ownership mismatch' }
}
if ($Action -eq 'create') {
    if ((Test-Path -LiteralPath $StateFile) -or (Test-Path -LiteralPath $coreStateFile)) { throw 'Refusing to replace worker fixture state' }
    $state=[ordered]@{schemaVersion=1;createdAt=[DateTime]::UtcNow.ToString('o');status='creating';
        coreStateFile=$coreStateFile;core=$null;run=$null;network=$null;redisImage=$redisImage;mongoImage=$mongoImage;springImage=$springImage;redis=$null;mongo=$null;spring=$null;springPreflight=$null}
    Save-WorkerState $state
    $null=& $coreScript -Action create -StateFile $coreStateFile -ExposeRabbitManagement
    $core=Get-Content -LiteralPath $coreStateFile -Raw | ConvertFrom-Json
    if ($core.status -ne 'ready') { throw 'Core fixture did not become ready' }
    $state.core=$core; $state.run=$core.run; $state.network=$core.network; Save-WorkerState $state
    foreach ($kind in @('redis','mongo','spring')) {
        $name="$($core.network)-$kind"; $volume="$name-data"
        $entry=@{name=$name;volume=$volume;containerId=$null}
        $state[$kind]=$entry; Save-WorkerState $state
        $null=Invoke-WorkerDocker @('volume','create','--label',"io.eosrio.qualifier=$extraLabel",'--label',"io.eosrio.run=$($core.run)",$volume)
        $args=@('run','-d','--name',$name,'--hostname',$name,'--network',$core.network,
            '--label',"io.eosrio.qualifier=$extraLabel",'--label',"io.eosrio.run=$($core.run)")
        if ($kind -eq 'redis') {
            $args+=@('--cpus','1','--memory','512m','-p','127.0.0.1::6379',
                '--mount',"type=volume,src=$volume,dst=/data",$redisImage,'redis-server','--appendonly','yes','--maxmemory','384mb','--maxmemory-policy','noeviction')
        } elseif ($kind -eq 'mongo') {
            $args+=@('--cpus','1','--memory','1g','-p','127.0.0.1::27017',
                '--mount',"type=volume,src=$volume,dst=/data/db",'--tmpfs','/data/configdb:rw,size=64m',
                $mongoImage,'mongod','--bind_ip_all','--wiredTigerCacheSizeGB','0.25')
        } else {
            $config=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'fixture/worker-nodeos-config.ini')).Path
            $genesis=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../../tests/e2e/nodeos/genesis.json')).Path
            $entry.configSha256=(Get-FileHash -LiteralPath $config -Algorithm SHA256).Hash.ToLowerInvariant()
            $entry.genesisSha256=(Get-FileHash -LiteralPath $genesis -Algorithm SHA256).Hash.ToLowerInvariant()
            $probeName="$name-options"
            $probeArgs=@('run','--rm','--name',$probeName,'--network','none','--cpus','1','--memory','256m',
                '--label',"io.eosrio.qualifier=$extraLabel",'--label',"io.eosrio.run=$($core.run)",
                '--entrypoint','/bin/sh',$springImage,'-c','nodeos --version && nodeos --help')
            $state.springPreflight=@{name=$probeName;containerId=$null;volume=$null;dockerArgs=$probeArgs;completed=$false}
            Save-WorkerState $state
            $probeOutput=@(Invoke-WorkerDocker $probeArgs)
            if ($probeOutput.Count -lt 2) { throw 'Spring options preflight returned incomplete output' }
            $entry.version=$probeOutput[0].Trim()
            if ($entry.version -notmatch '^v?1\.2\.2(?:\b|[-+])') { throw 'Unexpected Spring version' }
            $help=($probeOutput | Select-Object -Skip 1 | Out-String)
            $options=@(Get-Content -LiteralPath $config | ForEach-Object {
                if ($_ -match '^([a-z][a-z0-9-]*)\s*=') { $Matches[1] }
            } | Sort-Object -Unique)
            foreach ($option in $options) {
                if ($help -notmatch ('--'+[regex]::Escape($option)+'(?:\s|=|$)')) { throw "Spring binary does not advertise configured option: $option" }
            }
            $entry.checkedConfigOptions=$options
            $entry.optionsHelpSha256=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($help))).ToLowerInvariant()
            $state.springPreflight.completed=$true; Save-WorkerState $state
            $args+=@('--cpus','2','--memory','2g','-p','127.0.0.1::8888','-p','127.0.0.1::8080',
                '--mount',"type=volume,src=$volume,dst=/var/lib/nodeos",
                '--mount',"type=bind,src=$config,dst=/fixture/config.ini,readonly",
                '--mount',"type=bind,src=$genesis,dst=/fixture/genesis.json,readonly",$springImage,
                '--config','/fixture/config.ini','--data-dir','/var/lib/nodeos','--genesis-json','/fixture/genesis.json',
                '--signature-provider','EOS6MRyAjQq8ud7hVNYcfnVPJqcVpscN5So8BhtHuGYqET5GDW5CV=KEY:5KQwrPbwdL6PhXujxW37FSSQZ1JiwsST4cqQzDeyXtP79zkvFD3')
        }
        $cid=(Invoke-WorkerDocker $args).Trim()
        $entry.containerId=$cid; $entry.dockerArgs=$args; Save-WorkerState $state
        if ($kind -eq 'redis') {
            $entry.url='redis://'+(Invoke-WorkerDocker @('port',$cid,'6379/tcp')).Trim()
        } elseif ($kind -eq 'mongo') {
            $entry.url='mongodb://'+(Invoke-WorkerDocker @('port',$cid,'27017/tcp')).Trim()
        } else {
            $entry.httpUrl='http://'+(Invoke-WorkerDocker @('port',$cid,'8888/tcp')).Trim()
            $entry.shipUrl='ws://'+(Invoke-WorkerDocker @('port',$cid,'8080/tcp')).Trim()
        }
        Save-WorkerState $state
    }
    $deadline=[DateTime]::UtcNow.AddSeconds(60)
    do {
        try {
            $info=Invoke-RestMethod "$($state.spring.httpUrl)/v1/chain/get_info" -Method Post -ContentType application/json -Body '{}' -TimeoutSec 2
            if ($info.chain_id -notmatch '^[a-f0-9]{64}$' -or $info.head_block_num -lt 2) { throw 'Disposable chain not producing yet' }
            $ping=(Invoke-WorkerDocker @('exec',$state.redis.containerId,'redis-cli','PING') | Out-String).Trim()
            if ($ping -ne 'PONG') { throw 'Redis not ready' }
            $mongoPing=(Invoke-WorkerDocker @('exec',$state.mongo.containerId,'mongosh','--quiet','--eval','if (!db.adminCommand({ping:1}).ok) quit(1); print("PONG")') | Out-String).Trim()
            if ($mongoPing -ne 'PONG') { throw 'MongoDB not ready' }
            $state.spring.chainId=$info.chain_id; $state.spring.initialInfo=$info
            $state.status='ready'; Save-WorkerState $state
            Write-Output "Ready full-worker fixture $($state.run) chain $($info.chain_id)"
            exit 0
        } catch { $state.readinessError=$_.Exception.Message; Save-WorkerState $state; Start-Sleep -Milliseconds 500 }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Worker fixture did not become ready; preserved state allows exact cleanup'
}
$state=Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
if ($state.schemaVersion -ne 1 -or $state.coreStateFile -ne $coreStateFile -or $state.redisImage -ne $redisImage -or $state.mongoImage -ne $mongoImage -or $state.springImage -ne $springImage) { throw 'Invalid worker fixture state' }
if (-not (Test-Path -LiteralPath $coreStateFile)) {
    if ($state.run -or $state.redis -or $state.mongo -or $state.spring -or $state.springPreflight) { throw 'Missing core fixture journal' }
    Write-Output 'No core journal or Docker resources were created'
    exit 0
}
$core=Get-Content -LiteralPath $coreStateFile -Raw | ConvertFrom-Json
if ($core.run -notmatch '^[a-f0-9]{12}$' -or $core.network -ne "hyp-es955-replicas-$($core.run)" -or ($state.run -and $state.run -ne $core.run)) { throw 'Invalid core fixture identity' }
if ($core.esImage -ne 'docker.elastic.co/elasticsearch/elasticsearch@sha256:c40a1fb2bc6976821e5625d2329992a1e9c29df576e5955fdcba02421abf0d3c' -or
    $core.rabbitImage -ne 'rabbitmq@sha256:09b39ca8a3e884e91cab8842cd41264de21aab0625e1f1d016a9a3135ba590ef') { throw 'Unexpected core fixture images' }
# Validate every resource before deleting extras. The original cleanup validates again
# after extra endpoints are removed, preserving its strict network-consumer guard.
$planned=@()
foreach ($item in @($core.nodes)+@($core.broker) | Where-Object { $_ }) {
    if ($item.name -notin @("$($core.network)-a","$($core.network)-b","$($core.network)-witness","$($core.network)-rabbit")) { throw 'Unexpected core resource intent' }
    $isBroker=$item.name -eq "$($core.network)-rabbit"
    $planned+=@(@{item=$item;label='es198-replicas';image=if($isBroker){$core.rabbitImage}else{$core.esImage};
        destination=if($isBroker){'/var/lib/rabbitmq'}else{'/usr/share/elasticsearch/data'};extra=$false})
}
foreach ($kind in @('redis','mongo','spring')) {
    $item=$state.$kind
    if (-not $item) { continue }
    if ($item.name -ne "$($core.network)-$kind") { throw 'Unexpected worker resource intent' }
    $image=switch($kind){'redis'{$redisImage};'mongo'{$mongoImage};'spring'{$springImage}}
    $destination=switch($kind){'redis'{'/data'};'mongo'{'/data/db'};'spring'{'/var/lib/nodeos'}}
    $planned+=@(@{item=$item;label=$extraLabel;image=$image;destination=$destination;extra=$true})
}
if ($state.springPreflight) {
    if ($state.springPreflight.name -ne "$($core.network)-spring-options" -or $state.springPreflight.volume) { throw 'Unexpected Spring preflight intent' }
    $planned+=@(@{item=$state.springPreflight;label=$extraLabel;image=$springImage;destination=$null;extra=$true})
}
$inventory=@(Invoke-WorkerDocker @('ps','-a','--no-trunc','--filter',"label=io.eosrio.run=$($core.run)",'--format','{{.ID}}|{{.Names}}'))
$volumeInventory=@(Invoke-WorkerDocker @('volume','ls','--filter',"label=io.eosrio.run=$($core.run)",'--format','{{.Name}}'))
$allContainers=@(); $allVolumes=@(); $extraContainers=@(); $extraVolumes=@()
foreach ($plan in $planned) {
    $item=$plan.item
    if ($plan.destination -and $item.volume -ne "$($item.name)-data") { throw 'Unexpected volume intent' }
    $matches=@($inventory | Where-Object { $_.Split('|',2)[1] -eq $item.name })
    if ($matches.Count -gt 1) { throw 'Ambiguous container identity' }
    $cid=if($matches.Count){$matches[0].Split('|',2)[0]}else{$null}
    if ($cid) {
        if ($item.containerId -and $item.containerId -ne $cid) { throw 'Container identity changed' }
        $ins=@((Invoke-WorkerDocker @('inspect',$cid)) | ConvertFrom-Json)[0]
        Assert-WorkerLabels $ins.Config.Labels $core.run $plan.label
        if ($ins.Id -ne $cid -or $ins.Name -ne '/'+$item.name -or $ins.Config.Image -ne $plan.image) { throw 'Container identity or image changed' }
        $mounts=@($ins.Mounts | Where-Object { $_.Type -eq 'volume' })
        if ($plan.destination) {
            if ($mounts.Count -ne 1 -or $mounts[0].Name -ne $item.volume -or $mounts[0].Destination -ne $plan.destination) { throw 'Container volume changed' }
        } elseif ($mounts.Count) { throw 'Unexpected preflight volume' }
        $allContainers+=@($cid)
        if ($plan.extra) { $extraContainers+=@($cid) }
    }
    if ($item.volume -and $item.volume -in $volumeInventory) {
        $volume=@((Invoke-WorkerDocker @('volume','inspect',$item.volume)) | ConvertFrom-Json)[0]
        Assert-WorkerLabels $volume.Labels $core.run $plan.label
        $users=@(Invoke-WorkerDocker @('ps','-a','--no-trunc','--filter',"volume=$($item.volume)",'--format','{{.ID}}'))
        if ($users.Count -gt 1 -or ($users.Count -eq 1 -and $users[0] -ne $cid)) { throw 'Unexpected volume consumer' }
        $allVolumes+=@($item.volume)
        if ($plan.extra) { $extraVolumes+=@($item.volume) }
    }
}
if ($inventory.Count -ne $allContainers.Count -or $volumeInventory.Count -ne $allVolumes.Count) { throw 'Unplanned run-labelled resources; preserve for inspection' }
$networks=@(Invoke-WorkerDocker @('network','ls','--filter',"label=io.eosrio.run=$($core.run)",'--format','{{.Name}}'))
if (@($networks | Where-Object { $_ -ne $core.network }).Count) { throw 'Unexpected run-labelled network' }
if ($core.network -in $networks) {
    $network=@((Invoke-WorkerDocker @('network','inspect',$core.network)) | ConvertFrom-Json)[0]
    Assert-WorkerLabels $network.Labels $core.run 'es198-replicas'
    foreach ($property in @($network.Containers.psobject.Properties)) {
        if ($property.Name -notin $allContainers) { throw 'Unexpected network consumer' }
    }
}
$receipt=[ordered]@{schemaVersion=1;run=$core.run;validatedAt=[DateTime]::UtcNow.ToString('o');extraContainers=@();extraVolumes=@();coreStateFile=$coreStateFile}
foreach ($cid in $extraContainers) { $null=Invoke-WorkerDocker @('rm','--force',$cid); $receipt.extraContainers+=@($cid) }
foreach ($volume in $extraVolumes) { $null=Invoke-WorkerDocker @('volume','rm',$volume); $receipt.extraVolumes+=@($volume) }
$null=& $coreScript -Action cleanup -StateFile $coreStateFile
$receipt.coreCleanup=Get-Content -LiteralPath ($coreStateFile+'.cleanup.json') -Raw | ConvertFrom-Json
$receipt.completedAt=[DateTime]::UtcNow.ToString('o')
[IO.File]::WriteAllText($StateFile+'.cleanup.json',($receipt | ConvertTo-Json -Depth 15)+"`n",[Text.UTF8Encoding]::new($false))
Write-Output 'Removed exact owned full-worker fixture and core resources'
