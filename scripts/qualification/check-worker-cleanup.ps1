param(
    [string]$FixtureScript=(Join-Path $PSScriptRoot 'es955-worker-fixture.ps1'),
    [string]$OutputFile
)
$ErrorActionPreference='Stop'
$FixtureScript=(Resolve-Path -LiteralPath $FixtureScript).Path
foreach ($command in @('docker','Invoke-RestMethod')) {
    if ((Get-Command $command -ErrorAction SilentlyContinue).CommandType -in @('Alias','Function')) { throw "Run in a fresh PowerShell process; refusing to replace $command" }
}
$results=[Collections.Generic.List[object]]::new()
# Every Docker and HTTP call made by both real fixture scripts is intercepted.
# There is no executable or network fallback in either mock.
function global:docker {
    $global:LASTEXITCODE=0
    $a=@($args); $m=$global:WorkerFixtureMock; $m.calls.Add($a)
    switch ($a[0]) {
        'network' {
            switch ($a[1]) {
                'create' { $m.network=$a[-1]; $m.run=$m.network.Substring($m.network.Length-12); return 'network-created' }
                'ls' { if ($m.network) { return $m.network }; return }
                'inspect' {
                    $ends=@{}
                    foreach($id in $m.containers.Keys) { $ends[$id]=@{Name=$m.containers[$id].name} }
                    if($m.foreignNetwork) { $ends['f'*64]=@{Name='outside-consumer'} }
                    return (@{Name=$m.network;Labels=@{'io.eosrio.qualifier'='es198-replicas';'io.eosrio.run'=$m.run};Containers=$ends}|ConvertTo-Json -Depth 8 -Compress)
                }
                'rm' { $m.mutations++; $m.network=$null; return 'network-removed' }
                default { throw 'Unexpected mock network command' }
            }
        }
        'volume' {
            switch($a[1]) {
                'create' {
                    $qualifier=if($a[-1] -match '-(redis|mongo|spring)-data$'){'es198-workers'}else{'es198-replicas'}
                    $m.volumes[$a[-1]]=@{name=$a[-1];labels=@{'io.eosrio.qualifier'=$qualifier;'io.eosrio.run'=$m.run}}
                    return $a[-1]
                }
                'ls' { return @($m.volumes.Keys) }
                'inspect' { return (@{Name=$a[-1];Labels=$m.volumes[$a[-1]].labels}|ConvertTo-Json -Depth 5 -Compress) }
                'rm' {
                    $m.mutations++
                    if($m.interruptRemoval){$m.interruptRemoval=$false;throw 'Injected interrupted worker volume removal'}
                    $m.volumes.Remove($a[-1]); return 'volume-removed'
                }
                default { throw 'Unexpected mock volume command' }
            }
        }
        'run' {
            $name=$a[[array]::IndexOf($a,'--name')+1]
            if($name.EndsWith('-spring-options')){
                if($m.mode -eq 'preflight-interruption'){
                    $id=('{0:x64}' -f ($m.containers.Count+1))
                    $m.containers[$id]=@{name=$name;kind='preflight';volume=$null;image=@($a | Where-Object {$_ -match '@sha256:'})[0];destination=$null;
                        labels=@{'io.eosrio.qualifier'='es198-workers';'io.eosrio.run'=$m.run}}
                    throw 'Injected interrupted Spring preflight'
                }
                if($m.mode -eq 'spring-version'){'v9.0.0'}else{'v1.2.2'}
                $configuration=Join-Path (Split-Path -Parent $FixtureScript) 'fixture/worker-nodeos-config.ini'
                return @(Get-Content -LiteralPath $configuration | ForEach-Object {if($_ -match '^([a-z][a-z0-9-]*)\s*='){ '--'+$Matches[1]+' arg' }})
            }
            $kind=if($name.EndsWith('-redis')){'redis'}elseif($name.EndsWith('-mongo')){'mongo'}elseif($name.EndsWith('-spring')){'spring'}else{'core'}
            if($m.mode -eq "$kind-run"){throw "Injected $kind run failure"}
            $cid=('{0:x64}' -f ($m.containers.Count+1))
            $image=@($a | Where-Object { $_ -match '@sha256:' })[0]
            $destination=switch($kind){'redis'{'/data'};'mongo'{'/data/db'};'spring'{'/var/lib/nodeos'};default{if($name.EndsWith('-rabbit')){'/var/lib/rabbitmq'}else{'/usr/share/elasticsearch/data'}}}
            $qualifier=if($kind -eq 'core'){'es198-replicas'}else{'es198-workers'}
            $m.containers[$cid]=@{name=$name;kind=$kind;volume="$name-data";image=$image;destination=$destination;
                labels=@{'io.eosrio.qualifier'=$qualifier;'io.eosrio.run'=$m.run}}
            return $cid
        }
        'port' {
            $kind=$m.containers[$a[1]].kind
            if($m.mode -eq "$kind-port"){throw "Injected $kind port failure"}
            return ('127.0.0.1:'+(25000+[int]$a[2].Split('/')[0]))
        }
        'exec' {
            if($a[2] -eq 'nodeos'){
                if($a[3] -eq '--help'){
                    $configuration=Join-Path (Split-Path -Parent $FixtureScript) 'fixture/worker-nodeos-config.ini'
                    return @(Get-Content -LiteralPath $configuration | ForEach-Object {if($_ -match '^([a-z][a-z0-9-]*)\s*='){ '--'+$Matches[1]+' arg' }})
                }
                if($m.mode -eq 'spring-version'){return 'v9.0.0'}
                return 'v1.2.2'
            }
            if($a[2] -in @('redis-cli','mongosh')){return 'PONG'}
            throw 'Unexpected mock exec command'
        }
        'ps' {
            $filter=$a[[array]::IndexOf($a,'--filter')+1]
            $format=$a[[array]::IndexOf($a,'--format')+1]
            foreach($id in @($m.containers.Keys)){
                $container=$m.containers[$id]
                if($filter.StartsWith('volume=') -and $container.volume -ne $filter.Substring(7)){continue}
                if($format -eq '{{.ID}}|{{.Names}}'){"$id|$($container.name)"}else{$id}
            }
            if($m.foreignVolume -and $filter.StartsWith('volume=') -and $filter.EndsWith('-redis-data')){'f'*64}
            return
        }
        'inspect' {
            $id=$a[-1];$container=$m.containers[$id]
            $image=if($m.changedImage -and $container.kind -eq 'spring'){'foreign:latest'}else{$container.image}
            $mounts=if($container.volume){@(@{Type='volume';Name=$container.volume;Destination=$container.destination})}else{@()}
            return (@{Id=$id;Name='/'+$container.name;Config=@{Image=$image;Labels=$container.labels};Mounts=@($mounts)}|ConvertTo-Json -Depth 8 -Compress)
        }
        'rm' { $m.mutations++;$m.containers.Remove($a[-1]);return 'container-removed' }
        default { throw ('Unexpected mock Docker call '+($a -join ' ')) }
    }
}
function global:Invoke-RestMethod {
    param([string]$Uri,$Method,$ContentType,$Body,$TimeoutSec)
    $m=$global:WorkerFixtureMock
    if($Uri.EndsWith('/_cluster/health')){return @{number_of_nodes=3}}
    if($Uri.EndsWith('/v1/chain/get_info')){return @{chain_id=('a'*64);head_block_num=2;last_irreversible_block_num=1}}
    return @{cluster_name="hyperion-es198-$($m.run)";cluster_uuid='mock-owned-uuid';version=@{number='9.5.5'}}
}
function Assert-FailsWithoutMutation([scriptblock]$Operation,[string]$Expected) {
    $before=$global:WorkerFixtureMock.mutations
    $caught=$null
    try { &$Operation } catch { $caught=$_.Exception.Message }
    if($caught -ne $Expected){throw "Expected '$Expected', got '$caught'"}
    if($global:WorkerFixtureMock.mutations -ne $before){throw 'Ownership rejection occurred after destructive mutation'}
}
try {
    foreach($mode in @('redis-run','redis-port','mongo-run','mongo-port','spring-run','spring-port','spring-version','preflight-interruption','ready')){
        $path=Join-Path ([IO.Path]::GetTempPath()) ('es198-workers-review-'+[guid]::NewGuid().ToString('N')+'.json')
        $global:WorkerFixtureMock=@{mode=$mode;run=$null;network=$null;containers=@{};volumes=@{};
            calls=[Collections.Generic.List[object]]::new();mutations=0;interruptRemoval=$false;
            foreignNetwork=$false;foreignVolume=$false;changedImage=$false}
        try {
            $caught=$null
            try {$null=& $FixtureScript -Action create -StateFile $path}catch{$caught=$_.Exception.Message}
            $expected=switch($mode){'ready'{$null};'spring-version'{'Unexpected Spring version'};'preflight-interruption'{'Injected interrupted Spring preflight'};default{'Injected '+$mode.Replace('-',' ')+' failure'}}
            if($caught -ne $expected){throw "Create mode $mode expected '$expected', got '$caught'"}
            $state=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
            $core=Get-Content -LiteralPath ($path+'.core.json') -Raw | ConvertFrom-Json
            if(-not $core.broker.managementUrl.StartsWith('http://127.0.0.1:')){throw 'Missing loopback broker management endpoint'}
            $kind=if($mode.StartsWith('redis-')){'redis'}elseif($mode.StartsWith('mongo-')){'mongo'}else{'spring'}
            if(-not $state.$kind -or $state.$kind.volume -ne "$($state.$kind.name)-data"){throw 'Missing extra resource intent'}
            if($mode.EndsWith('-run') -and $state.$kind.containerId){throw 'Run failure unexpectedly persisted CID'}
            if($mode.EndsWith('-port') -and -not $state.$kind.containerId){throw 'Port failure lost created CID'}
            if($mode -eq 'ready'){
                if($state.status -ne 'ready' -or $state.spring.version -ne 'v1.2.2' -or $state.spring.chainId -ne 'a'*64){throw 'Incomplete ready manifest'}
                $before=$global:WorkerFixtureMock.calls.Count
                Assert-FailsWithoutMutation { $null=& $FixtureScript -Action create -StateFile $path } 'Refusing to replace worker fixture state'
                if($global:WorkerFixtureMock.calls.Count -ne $before){throw 'Create refusal called Docker'}
                $global:WorkerFixtureMock.foreignVolume=$true
                Assert-FailsWithoutMutation { $null=& $FixtureScript -Action cleanup -StateFile $path } 'Unexpected volume consumer'
                $global:WorkerFixtureMock.foreignVolume=$false
                $global:WorkerFixtureMock.foreignNetwork=$true
                Assert-FailsWithoutMutation { $null=& $FixtureScript -Action cleanup -StateFile $path } 'Unexpected network consumer'
                $global:WorkerFixtureMock.foreignNetwork=$false
                $global:WorkerFixtureMock.changedImage=$true
                Assert-FailsWithoutMutation { $null=& $FixtureScript -Action cleanup -StateFile $path } 'Container identity or image changed'
                $global:WorkerFixtureMock.changedImage=$false
                $results.Add(@{scenario='ownership-guards-before-any-removal';passed=$true;guards=@('existing-state','outside-volume-consumer','outside-network-consumer','changed-image');realDockerCalls=0})
                $global:WorkerFixtureMock.interruptRemoval=$true
                $cleanupError=$null
                try{$null=& $FixtureScript -Action cleanup -StateFile $path}catch{$cleanupError=$_.Exception.Message}
                if($cleanupError -ne 'Injected interrupted worker volume removal'){throw "Unexpected interrupted cleanup error: $cleanupError"}
                if($global:WorkerFixtureMock.containers.Count -ne 4){throw 'Interrupted extra removal damaged core containers'}
                $results.Add(@{scenario='interrupted-extra-volume-cleanup';passed=$true;coreContainersPreserved=4;realDockerCalls=0})
            }
            $null=& $FixtureScript -Action cleanup -StateFile $path
            $null=& $FixtureScript -Action cleanup -StateFile $path
            if($global:WorkerFixtureMock.network -or $global:WorkerFixtureMock.containers.Count -or $global:WorkerFixtureMock.volumes.Count){throw 'Resources remain after repeated cleanup'}
            $receipt=Get-Content -LiteralPath ($path+'.cleanup.json') -Raw|ConvertFrom-Json
            if($receipt.coreCleanup.remainingContainers -or $receipt.coreCleanup.remainingVolumes -or $receipt.coreCleanup.remainingNetworks){throw 'Cleanup receipt reports residue'}
            $results.Add(@{scenario=$mode;passed=$true;creationError=$caught;repeatedCleanupPassed=$true;realDockerCalls=0;
                commands=$global:WorkerFixtureMock.calls.ToArray()})
        } finally {
            foreach($file in @($path,($path+'.core.json'),($path+'.cleanup.json'),($path+'.core.json.cleanup.json'))){
                if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file}
            }
        }
    }
    $report=[ordered]@{schemaVersion=1;status='passed';realDockerCalls=0;scenarioCount=$results.Count;
        fixtureScriptSha256=(Get-FileHash -LiteralPath $FixtureScript -Algorithm SHA256).Hash.ToLowerInvariant();
        testScriptSha256=(Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant();
        scenarios=$results.ToArray();completedAt=[DateTime]::UtcNow.ToString('o')}
    $json=($report|ConvertTo-Json -Depth 20)+"`n"
    if($OutputFile){[IO.File]::WriteAllText($OutputFile,$json,[Text.UTF8Encoding]::new($false))}
    Write-Output $json
} finally {
    Remove-Item function:\docker
    Remove-Item function:\Invoke-RestMethod
    Remove-Variable WorkerFixtureMock -Scope Global -ErrorAction SilentlyContinue
}
